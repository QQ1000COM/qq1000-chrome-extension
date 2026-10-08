import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";

const source = fs.readFileSync(new URL("../popup.js", import.meta.url), "utf8");
const TOKEN = "cj-user-token";
const INFO = "cj-user-info";
const settle = async () => {
    await new Promise(resolve => setTimeout(resolve, 2));
    for (let index = 0; index < 8; index++) await new Promise(resolve => setImmediate(resolve));
};
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const response = (data, status = 200) => ({ status, text: async () => JSON.stringify(data) });
const account = name => ({ code: 0, state: true, data: { id: name, username: name, pluginQuotas: [] } });

class Element {
    constructor() {
        this.children = [];
        this.style = {};
        this.hidden = true;
        this.textContent = "";
        this.innerHTML = "";
        this.classList = { toggle: (_name, hidden) => { this.hidden = hidden; } };
    }
    appendChild(child) { this.children.push(child); }
    replaceChildren() { this.children = []; }
}

function popup({ token = "first-synthetic", localToken = token, fetchImpl, failWrites = false, cachedInfo, afterWrite } = {}) {
    const state = { sync: token ? { [TOKEN]: token } : {}, local: localToken ? { [TOKEN]: localToken } : {} };
    if (cachedInfo) state.sync[INFO] = cachedInfo;
    const listeners = [];
    const requests = [];
    let writesPaused = false;
    const pendingWrites = [];
    const runtime = {};
    const notify = (changes, name) => listeners.forEach(listener => listener(changes, name));
    const area = name => ({
        get: (keys, callback) => {
            const result = Object.fromEntries(keys.filter(key => key in state[name]).map(key => [key, state[name][key]]));
            setImmediate(() => callback(result));
        },
        set: (values, callback) => {
            const complete = () => {
            if (failWrites) {
                runtime.lastError = { message: "Storage write failed" };
                callback();
                delete runtime.lastError;
                return;
            }
            const changes = {};
            for (const [key, value] of Object.entries(values)) {
                const oldValue = state[name][key];
                state[name][key] = value;
                if (oldValue !== value) changes[key] = { oldValue, newValue: value };
            }
            callback();
            if (Object.keys(changes).length) notify(changes, name);
            afterWrite?.(name, values);
            };
            if (writesPaused) pendingWrites.push(complete);
            else setImmediate(complete);
        },
        remove: (keys, callback) => setImmediate(() => {
            const changes = {};
            for (const key of keys) {
                if (key in state[name]) changes[key] = { oldValue: state[name][key] };
                delete state[name][key];
            }
            callback();
            if (Object.keys(changes).length) notify(changes, name);
        }),
    });
    const elements = Object.fromEntries(["panelUser", "panelLogin", "userName", "userMeta", "quotaList", "status", "keyInput", "loginBtn"].map(key => [key, new Element()]));
    elements.keyInput.value = "login-synthetic";
    const context = vm.createContext({
        document: { addEventListener() {}, createElement: () => new Element() },
        window: { localStorage: { setItem() {}, removeItem() {} } },
        chrome: { runtime, storage: { sync: area("sync"), local: area("local"), onChanged: { addListener: listener => listeners.push(listener) } }, tabs: { query: (_, callback) => callback([]) } },
        AbortController, setTimeout, clearTimeout,
        fetch: async (url, options) => {
            requests.push({ url, options });
            return fetchImpl ? fetchImpl(url, options) : response(account(options.headers["user-token"]));
        },
        elements,
    });
    vm.runInContext(source, context);
    vm.runInContext("Object.assign(els, elements)", context);
    return {
        state, requests, elements,
        pauseWrites: () => { writesPaused = true; },
        resumeWrites: () => { writesPaused = false; pendingWrites.splice(0).forEach(complete => setImmediate(complete)); },
        run: expression => vm.runInContext(expression, context),
        changeToken: value => {
            for (const name of ["sync", "local"]) {
                const oldValue = state[name][TOKEN];
                if (value) state[name][TOKEN] = value;
                else delete state[name][TOKEN];
                notify({ [TOKEN]: { oldValue, newValue: value } }, name);
            }
        },
    };
}

test("a delayed unauthorized account response cannot clear a newer login", async () => {
    const old = deferred();
    const app = popup({ fetchImpl: (_url, options) => options.headers["user-token"] === "first-synthetic" ? old.promise : response(account("second-account")) });
    const loading = app.run("loadUser()");
    await settle();
    app.changeToken("second-synthetic");
    await settle();
    old.resolve(response({}, 401));
    await loading;
    await settle();
    assert.equal(app.state.sync[TOKEN], "second-synthetic");
    assert.equal(app.state.local[TOKEN], "second-synthetic");
});

test("a delayed successful refresh cannot restore the user panel after logout", async () => {
    const info = deferred();
    const app = popup({ fetchImpl: url => url.endsWith("/user/info") ? info.promise : response({ code: 0 }) });
    const loading = app.run("loadUser()");
    await settle();
    await app.run("handleLogout()");
    info.resolve(response(account("old-account")));
    await loading;
    await settle();
    assert.equal(app.elements.panelUser.hidden, true);
    assert.equal(app.state.sync[INFO], undefined);
});

test("logout clears local credentials without waiting for the network", async () => {
    const logout = deferred();
    const app = popup({ fetchImpl: () => logout.promise });
    const done = app.run("handleLogout()");
    await settle();
    try {
        assert.equal(app.state.sync[TOKEN], undefined);
        assert.equal(app.state.local[TOKEN], undefined);
        assert.equal(app.elements.panelLogin.hidden, false);
    } finally {
        logout.resolve(response({ code: 0 }));
        await done;
    }
});

test("a late logout response cannot delete credentials saved by a later login", async () => {
    const logout = deferred();
    const app = popup({ fetchImpl: url => url.includes("out_login") ? logout.promise : response(account("new-account")) });
    const done = app.run("handleLogout()");
    await settle();
    app.changeToken("new-synthetic");
    logout.resolve(response({ code: 0 }));
    await done;
    await settle();
    assert.equal(app.state.sync[TOKEN], "new-synthetic");
});

test("repeated Enter submits only one login while verification is pending", async () => {
    const login = deferred();
    const app = popup({ token: "", fetchImpl: url => url.includes("longin/post") ? login.promise : response(account("new-account")) });
    const one = app.run("handleLogin()");
    const two = app.run("handleLogin()");
    await settle();
    const count = app.requests.filter(request => request.url.includes("longin/post")).length;
    login.resolve(response(account("new-account")));
    await Promise.all([one, two]);
    assert.equal(count, 1);
});

test("a nonzero business error never renders an empty successful account response", async () => {
    const app = popup({ fetchImpl: () => response({ code: 500, msg: "服务暂不可用" }) });
    await app.run("loadUser()");
    assert.match(app.elements.status.textContent, /服务暂不可用|稍后|网络|读取/);
    assert.notEqual(app.elements.quotaList.innerHTML, '<div class="muted">后台还没有配置插件。</div>');
    assert.equal(app.state.sync[TOKEN], "first-synthetic");
});

test("malformed quota rows cannot crash the account panel", async () => {
    const payload = account("valid-account");
    payload.data.pluginQuotas = [null, "bad-row", { name: "商品搬家", remaining: 2, quota: 5 }];
    const app = popup({ fetchImpl: () => response(payload) });
    await assert.doesNotReject(app.run("loadUser()"));
    assert.equal(app.elements.quotaList.children.length, 1);
});

test("failed storage writes keep the key available to retry and report the failure", async () => {
    const app = popup({ token: "", failWrites: true, fetchImpl: () => response(account("new-account")) });
    await app.run("handleLogin()");
    assert.equal(app.elements.keyInput.value, "login-synthetic");
    assert.match(app.elements.status.textContent, /保存|存储/);
    assert.equal(app.state.sync[TOKEN], undefined);
});

test("an open popup follows an external logout", async () => {
    const app = popup();
    await app.run("loadUser()");
    assert.equal(app.elements.panelUser.hidden, false);
    app.changeToken(undefined);
    await settle();
    assert.equal(app.elements.panelUser.hidden, true);
    assert.equal(app.elements.panelLogin.hidden, false);
});

test("offline account rendering never reuses a different stored account identity", async () => {
    const app = popup({ cachedInfo: { name: "unrelated-account", unlimited: true }, fetchImpl: () => { throw new Error("offline"); } });
    await app.run("loadUser()");
    assert.notEqual(app.elements.userName.textContent, "unrelated-account");
    assert.match(app.elements.status.textContent, /网络|验证|读取/);
    assert.equal(app.state.sync[TOKEN], "first-synthetic");
});

test("logout uses the same local fallback token as account loading", async () => {
    const app = popup({ token: "", localToken: "local-synthetic" });
    await app.run("handleLogout()");
    await settle();
    assert.equal(app.requests.find(request => request.url.includes("out_login"))?.options.headers["user-token"], "local-synthetic");
});

test("another popup switching accounts between storage writes cannot leave an old fallback credential", async () => {
    let app;
    let switched = false;
    app = popup({ token: "", afterWrite: (area, values) => {
        if (area === "sync" && values[TOKEN] && !switched) {
            switched = true;
            app.changeToken("newer-window-synthetic");
        }
    } });
    await app.run("handleLogin()");
    await settle();
    assert.equal(app.state.sync[TOKEN], "newer-window-synthetic");
    assert.equal(app.state.local[TOKEN], "newer-window-synthetic");
    assert.equal(app.elements.keyInput.value, "login-synthetic");
});

test("logout waits for a pending local login write, then removes that session", async () => {
    const app = popup({ token: "", fetchImpl: () => response(account("new-account")) });
    app.pauseWrites();
    const login = app.run("handleLogin()");
    await settle();
    const logout = app.run("handleLogout()");
    await settle();
    app.resumeWrites();
    await Promise.all([login, logout]);
    await settle();
    assert.equal(app.state.sync[TOKEN], undefined);
    assert.equal(app.state.local[TOKEN], undefined);
    assert.equal(app.elements.panelUser.hidden, true);
});
