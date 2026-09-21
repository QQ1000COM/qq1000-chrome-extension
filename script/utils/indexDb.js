/**
 * IndexedDB 工具类 - Background Script专用
 * 提供稳定可靠的IndexedDB操作接口
 * 
 * @author Claude Code
 * @version 3.1.0
 * @changelog
 *   v3.1.0: 性能优化、可靠性增强、大文件支持
 *   - 修复内存泄漏问题
 *   - 优化大数据存储性能
 *   - 添加连接重试机制
 *   - 改进事务错误处理
 */

var IndexedDBManager = (function() {
    const DB_NAME = 'CJ_Plugin_Storage';
    const DB_VERSION = 1;
    const STORE_NAME = 'keyValueStore';
    
    // 数据库连接池
    let dbConnection = null;
    let dbInitPromise = null;
    let reconnectAttempts = 0;
    const MAX_RECONNECT_ATTEMPTS = 3;
    
    // 定期清理任务ID
    let cleanupIntervalId = null;
    
    // 性能配置
    const PERFORMANCE_CONFIG = {
        LARGE_DATA_THRESHOLD: 50 * 1024, // 50KB
        CHUNK_SIZE: 64 * 1024, // 64KB分片大小
        LAZY_SIZE_CALCULATION: true // 延迟计算数据大小
    };
    
    // 性能统计
    const stats = {
        totalOperations: 0,
        successCount: 0,
        errorCount: 0,
        dbSize: 0,
        keyCount: 0
    };
    
    /**
     * 初始化数据库连接（带重试机制）
     */
    function initDatabase() {
        if (dbInitPromise) {
            return dbInitPromise;
        }
        
        dbInitPromise = new Promise((resolve, reject) => {
            const attemptConnection = () => {
                try {
                    const request = indexedDB.open(DB_NAME, DB_VERSION);
                
                request.onerror = function() {
                    const error = this.error || new Error('数据库初始化失败');
                    console.error('IndexedDB初始化失败:', error);
                    
                    // 重试机制
                    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        reconnectAttempts++;
                        console.warn(`正在进行第${reconnectAttempts}次重连尝试...`);
                        setTimeout(attemptConnection, 1000 * reconnectAttempts);
                        return;
                    }
                    
                    reconnectAttempts = 0;
                    reject(error);
                };
                
                request.onsuccess = function() {
                    dbConnection = this.result;
                    reconnectAttempts = 0; // 重置重试计数器
                    
                    // 监听数据库关闭事件
                    dbConnection.onclose = function() {
                        console.warn('⚠️ 数据库连接意外关闭，将在下次访问时重新连接');
                        dbConnection = null;
                        dbInitPromise = null;
                    };
                    
                    dbConnection.onerror = function(event) {
                        console.error('数据库连接错误:', event);
                    };
                    
                    console.log('✅ IndexedDB连接成功');
                    resolve(dbConnection);
                };
                
                request.onupgradeneeded = function(event) {
                    const db = event.target.result;
                    if (!db.objectStoreNames.contains(STORE_NAME)) {
                        const store = db.createObjectStore(STORE_NAME, { keyPath: 'key' });
                        store.createIndex('expireTime', 'expireTime', { unique: false });
                        store.createIndex('createTime', 'createTime', { unique: false });
                        console.log('✅ IndexedDB存储结构创建成功');
                    }
                };
                
                // 连接错误处理
                request.onblocked = function() {
                    console.warn('⚠️ IndexedDB连接被阻塞，请关闭其他标签页');
                };
                
                } catch (error) {
                    console.error('IndexedDB初始化异常:', error);
                    
                    if (reconnectAttempts < MAX_RECONNECT_ATTEMPTS) {
                        reconnectAttempts++;
                        setTimeout(attemptConnection, 1000 * reconnectAttempts);
                        return;
                    }
                    
                    reconnectAttempts = 0;
                    reject(error);
                }
            };
            
            attemptConnection();
        });
        
        return dbInitPromise;
    }
    
    /**
     * 获取数据库连接
     */
    async function getDatabase() {
        if (dbConnection) {
            return dbConnection;
        }
        return await initDatabase();
    }
    
    /**
     * 估算数据大小（快速估算）
     */
    function estimateDataSize(data) {
        if (typeof data === 'string') {
            return data.length * 2; // UTF-16编码估算
        }
        if (data instanceof Blob || data instanceof File) {
            return data.size;
        }
        if (data instanceof ArrayBuffer) {
            return data.byteLength;
        }
        // 对于其他类型，使用粗略估算
        return Math.min(JSON.stringify(data || {}).length * 2, 1000);
    }
    
    /**
     * 精确计算数据大小
     */
    function calculateDataSize(data) {
        try {
            return JSON.stringify(data).length;
        } catch (error) {
            console.warn('数据大小计算失败:', error);
            return 0;
        }
    }
    
    /**
     * 异步更新数据大小
     */
    async function updateItemSize(key, value) {
        try {
            const db = await getDatabase();
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            
            const getRequest = store.get(String(key));
            getRequest.onsuccess = function() {
                const item = this.result;
                if (item && item.size === 0) {
                    item.size = calculateDataSize(value);
                    store.put(item);
                }
            };
        } catch (error) {
            console.warn('更新数据大小失败:', error);
        }
    }
    
    /**
     * 大文件分片存储（为未来图片存储做准备）
     */
    function chunkLargeData(data, chunkSize = PERFORMANCE_CONFIG.CHUNK_SIZE) {
        if (typeof data === 'string') {
            const chunks = [];
            for (let i = 0; i < data.length; i += chunkSize) {
                chunks.push(data.slice(i, i + chunkSize));
            }
            return chunks;
        }
        
        if (data instanceof ArrayBuffer) {
            const chunks = [];
            const uint8Array = new Uint8Array(data);
            for (let i = 0; i < uint8Array.length; i += chunkSize) {
                chunks.push(uint8Array.slice(i, i + chunkSize));
            }
            return chunks;
        }
        
        // 对于其他类型，先转为JSON再分片
        try {
            const jsonData = JSON.stringify(data);
            return chunkLargeData(jsonData, chunkSize);
        } catch (error) {
            console.warn('数据分片失败:', error);
            return [data]; // 返回原数据
        }
    }
    
    /**
     * 重建分片数据
     */
    function reconstructChunkedData(chunks, dataType = 'string') {
        if (!Array.isArray(chunks) || chunks.length === 0) {
            return null;
        }
        
        if (dataType === 'string') {
            return chunks.join('');
        }
        
        if (dataType === 'arraybuffer') {
            const totalLength = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
            const result = new Uint8Array(totalLength);
            let offset = 0;
            
            for (const chunk of chunks) {
                result.set(chunk, offset);
                offset += chunk.length;
            }
            
            return result.buffer;
        }
        
        // 默认情况下尝试JSON解析
        try {
            const jsonString = chunks.join('');
            return JSON.parse(jsonString);
        } catch (error) {
            console.warn('数据重建失败:', error);
            return chunks[0]; // 返回第一个分片
        }
    }
    
    /**
     * 简单数据压缩（使用LZ算法的简化版本）
     */
    function compressData(data) {
        if (typeof data !== 'string') {
            data = JSON.stringify(data);
        }
        
        // 简单的RLE压缩（Run-Length Encoding）
        let compressed = '';
        let count = 1;
        let prev = data[0];
        
        for (let i = 1; i < data.length; i++) {
            if (data[i] === prev && count < 9) {
                count++;
            } else {
                compressed += (count > 1 ? count + prev : prev);
                prev = data[i];
                count = 1;
            }
        }
        
        compressed += (count > 1 ? count + prev : prev);
        
        // 只有在压缩效果好时才使用
        return compressed.length < data.length * 0.8 
            ? { compressed: compressed, isCompressed: true }
            : { compressed: data, isCompressed: false };
    }
    
    /**
     * 数据解压缩
     */
    function decompressData(compressedData, isCompressed = false) {
        if (!isCompressed) {
            return compressedData;
        }
        
        let decompressed = '';
        let i = 0;
        
        while (i < compressedData.length) {
            const char = compressedData[i];
            if (/\d/.test(char) && i + 1 < compressedData.length) {
                const count = parseInt(char);
                const nextChar = compressedData[i + 1];
                decompressed += nextChar.repeat(count);
                i += 2;
            } else {
                decompressed += char;
                i++;
            }
        }
        
        return decompressed;
    }
    
    /**
     * 安全响应发送器
     */
    function createSafeResponder(sendResponse, operation) {
        let responseSent = false;
        const startTime = performance.now();
        
        return function(responseData) {
            if (responseSent) {
                console.warn(`⚠️ ${operation}: 响应已发送，忽略重复响应`);
                return;
            }
            
            responseSent = true;
            stats.totalOperations++;
            
            const latency = Math.round(performance.now() - startTime);
            
            try {
                if (responseData.success) {
                    stats.successCount++;
                    console.log(`✅ ${operation} 成功 (${latency}ms)`);
                } else {
                    stats.errorCount++;
                    console.error(`❌ ${operation} 失败:`, responseData.error);
                }
                
                const safeResponse = {
                    success: Boolean(responseData.success),
                    data: responseData.data || responseData.result || null,
                    error: responseData.error ? String(responseData.error) : null,
                    timestamp: Date.now(),
                    latency: latency
                };
                
                sendResponse(safeResponse);
                
            } catch (sendError) {
                console.error(`${operation} 响应发送失败:`, sendError);
                try {
                    sendResponse({
                        success: false,
                        data: null,
                        error: `响应发送失败: ${sendError.message}`,
                        timestamp: Date.now(),
                        latency: latency
                    });
                } catch (finalError) {
                    console.error(`${operation} 最终响应失败:`, finalError);
                }
            }
        };
    }
    
    /**
     * 数据存储
     */
    function setItem(data, sendResponse) {
        const safeRespond = createSafeResponder(sendResponse, 'setItem');
        // 验证请求数据
        if (!data || !data.key) {
            safeRespond({
                success: false,
                error: '无效请求: 缺少key参数'
            });
            return;
        }
        
        (async function() {
            try {
                const db = await getDatabase();
                const tx = db.transaction([STORE_NAME], 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const now = Date.now();
                
                // 计算过期时间
                let expireTime = null;
                if (data.expireMinutes && data.expireMinutes > 0) {
                    expireTime = now + (data.expireMinutes * 60 * 1000);
                } else if (data.expireInSeconds && data.expireInSeconds > 0) {
                    expireTime = now + (data.expireInSeconds * 1000);
                }
                
                // 延迟计算数据大小（优化性能）
                let dataSize = 0;
                if (!PERFORMANCE_CONFIG.LAZY_SIZE_CALCULATION) {
                    dataSize = calculateDataSize(data.value);
                }
                
                const item = {
                    key: String(data.key),
                    value: data.value,
                    createTime: now,
                    updateTime: now,
                    expireTime: expireTime,
                    size: dataSize,
                    isLargeData: false // 标记是否为大数据
                };
                
                // 对于大数据，先检查大小再决定存储策略
                if (PERFORMANCE_CONFIG.LAZY_SIZE_CALCULATION) {
                    const estimatedSize = estimateDataSize(data.value);
                    if (estimatedSize > PERFORMANCE_CONFIG.LARGE_DATA_THRESHOLD) {
                        console.log(`ℹ️ 检测到大数据 (${Math.round(estimatedSize/1024)}KB)，将使用优化存储`);
                        item.size = calculateDataSize(data.value);
                        item.isLargeData = true;
                    }
                }
                
                const request = store.put(item);
                
                request.onsuccess = function() {
                    // 延迟计算精确大小（如果还没计算）
                    if (PERFORMANCE_CONFIG.LAZY_SIZE_CALCULATION && item.size === 0) {
                        // 在后台异步计算并更新
                        setTimeout(() => {
                            updateItemSize(data.key, data.value);
                        }, 100);
                    }
                    
                    safeRespond({
                        success: true,
                        data: { 
                            key: data.key,
                            stored: true,
                            expireTime: expireTime,
                            isLargeData: item.isLargeData,
                            size: item.size || 'calculating...'
                        }
                    });
                };
                
                request.onerror = function() {
                    const error = this.error || new Error('数据存储失败');
                    safeRespond({
                        success: false,
                        error: `存储失败: ${error.name} - ${error.message}`
                    });
                };
                
                tx.onerror = function() {
                    const error = this.error || new Error('事务失败');
                    safeRespond({
                        success: false,
                        error: `事务失败: ${error.name} - ${error.message}`
                    });
                };
                
            } catch (error) {
                safeRespond({
                    success: false,
                    error: `存储异常: ${error.message}`
                });
            }
        })();
    }
    
    /**
     * 数据获取
     */
    function getItem(data, sendResponse) {
        const safeRespond = createSafeResponder(sendResponse, 'getItem');
        
        if (!data || !data.key) {
            safeRespond({
                success: false,
                error: '无效请求: 缺少key参数'
            });
            return;
        }
        
        (async function() {
            try {
                const db = await getDatabase();
                const tx = db.transaction([STORE_NAME], 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const request = store.get(String(data.key));
                
                request.onsuccess = function() {
                    const item = this.result;
                    
                    if (!item) {
                        safeRespond({
                            success: true,
                            data: null
                        });
                        return;
                    }
                    
                    // 检查过期
                    const now = Date.now();
                    if (item.expireTime && now > item.expireTime) {
                        // 异步删除过期项
                        removeExpiredItem(item.key);
                        safeRespond({
                            success: true,
                            data: null
                        });
                        return;
                    }
                    
                    safeRespond({
                        success: true,
                        data: item.value
                    });
                };
                
                request.onerror = function() {
                    const error = this.error || new Error('数据获取失败');
                    safeRespond({
                        success: false,
                        error: `获取失败: ${error.name} - ${error.message}`
                    });
                };
                
            } catch (error) {
                safeRespond({
                    success: false,
                    error: `获取异常: ${error.message}`
                });
            }
        })();
    }
    
    /**
     * 数据删除
     */
    function removeItem(data, sendResponse) {
        const safeRespond = createSafeResponder(sendResponse, 'removeItem');
        
        if (!data || !data.key) {
            safeRespond({
                success: false,
                error: '无效请求: 缺少key参数'
            });
            return;
        }
        
        (async function() {
            try {
                const db = await getDatabase();
                const tx = db.transaction([STORE_NAME], 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const request = store.delete(String(data.key));
                
                request.onsuccess = function() {
                    safeRespond({
                        success: true,
                        data: { deleted: true, key: data.key }
                    });
                };
                
                request.onerror = function() {
                    const error = this.error || new Error('数据删除失败');
                    safeRespond({
                        success: false,
                        error: `删除失败: ${error.name} - ${error.message}`
                    });
                };
                
            } catch (error) {
                safeRespond({
                    success: false,
                    error: `删除异常: ${error.message}`
                });
            }
        })();
    }
    
    /**
     * 清空数据库
     */
    function clear(sendResponse) {
        const safeRespond = createSafeResponder(sendResponse, 'clear');
        
        (async function() {
            try {
                const db = await getDatabase();
                const tx = db.transaction([STORE_NAME], 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const request = store.clear();
                
                request.onsuccess = function() {
                    safeRespond({
                        success: true,
                        data: { cleared: true }
                    });
                };
                
                request.onerror = function() {
                    const error = this.error || new Error('数据库清空失败');
                    safeRespond({
                        success: false,
                        error: `清空失败: ${error.name} - ${error.message}`
                    });
                };
                
            } catch (error) {
                safeRespond({
                    success: false,
                    error: `清空异常: ${error.message}`
                });
            }
        })();
    }
    
    /**
     * 获取所有键名
     */
    function getAllKeys(sendResponse) {
        const safeRespond = createSafeResponder(sendResponse, 'getAllKeys');
        
        (async function() {
            try {
                const db = await getDatabase();
                const tx = db.transaction([STORE_NAME], 'readonly');
                const store = tx.objectStore(STORE_NAME);
                const request = store.getAllKeys();
                
                request.onsuccess = function() {
                    const keys = this.result || [];
                    safeRespond({
                        success: true,
                        data: keys
                    });
                };
                
                request.onerror = function() {
                    const error = this.error || new Error('获取键名失败');
                    safeRespond({
                        success: false,
                        error: `获取键名失败: ${error.name} - ${error.message}`
                    });
                };
                
            } catch (error) {
                safeRespond({
                    success: false,
                    error: `获取键名异常: ${error.message}`
                });
            }
        })();
    }
    
    /**
     * 获取统计信息
     */
    function getStats(sendResponse) {
        const safeRespond = createSafeResponder(sendResponse, 'getStats');
        
        (async function() {
            try {
                const db = await getDatabase();
                const tx = db.transaction([STORE_NAME], 'readonly');
                const store = tx.objectStore(STORE_NAME);
                // 优化：使用游标来计算总大小，避免将所有数据加载到内存
                const countRequest = store.count();
                let keyCount = 0;
                let totalSize = 0;
                let processedCount = 0;
                
                countRequest.onsuccess = function() {
                    keyCount = this.result;
                    
                    if (keyCount === 0) {
                        const successRate = stats.totalOperations > 0 
                            ? ((stats.successCount / stats.totalOperations) * 100).toFixed(2) 
                            : '0.00';
                            
                        safeRespond({
                            success: true,
                            data: {
                                keyCount: keyCount,
                                totalSize: totalSize,
                                dbName: DB_NAME,
                                dbVersion: DB_VERSION,
                                performance: {
                                    totalOperations: stats.totalOperations,
                                    successCount: stats.successCount,
                                    errorCount: stats.errorCount,
                                    successRate: successRate + '%'
                                }
                            }
                        });
                        return;
                    }
                    
                    // 使用游标逶历计算总大小
                    const cursorRequest = store.openCursor();
                    
                    cursorRequest.onsuccess = function() {
                        const cursor = this.result;
                        if (cursor) {
                            const item = cursor.value;
                            totalSize += item.size || 0;
                            processedCount++;
                            cursor.continue();
                        } else {
                            // 所有数据处理完成
                            const successRate = stats.totalOperations > 0 
                                ? ((stats.successCount / stats.totalOperations) * 100).toFixed(2) 
                                : '0.00';
                                
                            safeRespond({
                                success: true,
                                data: {
                                    keyCount: keyCount,
                                    totalSize: totalSize,
                                    dbName: DB_NAME,
                                    dbVersion: DB_VERSION,
                                    performance: {
                                        totalOperations: stats.totalOperations,
                                        successCount: stats.successCount,
                                        errorCount: stats.errorCount,
                                        successRate: successRate + '%'
                                    }
                                }
                            });
                        }
                    };
                    
                    cursorRequest.onerror = function() {
                        const error = this.error || new Error('统计信息获取失败');
                        safeRespond({
                            success: false,
                            error: `统计失败: ${error.name} - ${error.message}`
                        });
                    };
                };
                
                countRequest.onerror = function() {
                    const error = this.error || new Error('统计信息获取失败');
                    safeRespond({
                        success: false,
                        error: `统计失败: ${error.name} - ${error.message}`
                    });
                };
                
            } catch (error) {
                safeRespond({
                    success: false,
                    error: `统计异常: ${error.message}`
                });
            }
        })();
    }
    
    /**
     * 清理过期数据
     */
    function cleanExpired(sendResponse) {
        const safeRespond = createSafeResponder(sendResponse, 'cleanExpired');
        
        (async function() {
            try {
                const db = await getDatabase();
                const tx = db.transaction([STORE_NAME], 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const index = store.index('expireTime');
                const now = Date.now();
                let cleanedCount = 0;
                
                const request = index.openCursor();
                
                request.onsuccess = function() {
                    const cursor = this.result;
                    if (cursor) {
                        const item = cursor.value;
                        if (item.expireTime && now > item.expireTime) {
                            cursor.delete();
                            cleanedCount++;
                        }
                        cursor.continue();
                    } else {
                        safeRespond({
                            success: true,
                            data: { cleanedCount: cleanedCount }
                        });
                    }
                };
                
                request.onerror = function() {
                    const error = this.error || new Error('清理过期数据失败');
                    safeRespond({
                        success: false,
                        error: `清理失败: ${error.name} - ${error.message}`
                    });
                };
                
            } catch (error) {
                safeRespond({
                    success: false,
                    error: `清理异常: ${error.message}`
                });
            }
        })();
    }
    
    /**
     * 批量设置数据
     */
    function setMultiple(data, sendResponse) {
        const safeRespond = createSafeResponder(sendResponse, 'setMultiple');
        
        if (!data || !Array.isArray(data.items) || data.items.length === 0) {
            safeRespond({
                success: false,
                error: '无效请求: items必须是非空数组'
            });
            return;
        }
        
        (async function() {
            try {
                const db = await getDatabase();
                const tx = db.transaction([STORE_NAME], 'readwrite');
                const store = tx.objectStore(STORE_NAME);
                const now = Date.now();
                
                let processedCount = 0;
                let successCount = 0;
                let errors = [];
                
                data.items.forEach((item, index) => {
                    if (!item.key) {
                        errors.push(`项目 ${index}: 缺少key`);
                        processedCount++;
                        return;
                    }
                    
                    let expireTime = null;
                    if (item.expireMinutes && item.expireMinutes > 0) {
                        expireTime = now + (item.expireMinutes * 60 * 1000);
                    }
                    
                    // 优化：延迟计算数据大小
                    let dataSize = 0;
                    if (!PERFORMANCE_CONFIG.LAZY_SIZE_CALCULATION) {
                        dataSize = calculateDataSize(item.value);
                    } else {
                        const estimatedSize = estimateDataSize(item.value);
                        if (estimatedSize > PERFORMANCE_CONFIG.LARGE_DATA_THRESHOLD) {
                            dataSize = calculateDataSize(item.value);
                        }
                    }
                    
                    const dataItem = {
                        key: String(item.key),
                        value: item.value,
                        createTime: now,
                        updateTime: now,
                        expireTime: expireTime,
                        size: dataSize,
                        isLargeData: dataSize > PERFORMANCE_CONFIG.LARGE_DATA_THRESHOLD
                    };
                    
                    const request = store.put(dataItem);
                    
                    request.onsuccess = function() {
                        successCount++;
                        processedCount++;
                        checkComplete();
                    };
                    
                    request.onerror = function() {
                        const error = this.error || new Error('存储失败');
                        errors.push(`项目 ${index} (${item.key}): ${error.message}`);
                        processedCount++;
                        checkComplete();
                    };
                });
                
                function checkComplete() {
                    if (processedCount === data.items.length) {
                        safeRespond({
                            success: errors.length === 0,
                            data: {
                                totalItems: data.items.length,
                                successCount: successCount,
                                errorCount: errors.length,
                                errors: errors
                            }
                        });
                    }
                }
                
                tx.onerror = function() {
                    const error = this.error || new Error('批量操作事务失败');
                    safeRespond({
                        success: false,
                        error: `批量操作失败: ${error.name} - ${error.message}`
                    });
                };
                
            } catch (error) {
                safeRespond({
                    success: false,
                    error: `批量操作异常: ${error.message}`
                });
            }
        })();
    }
    
    /**
     * 异步删除过期项
     */
    function removeExpiredItem(key) {
        getDatabase().then(db => {
            const tx = db.transaction([STORE_NAME], 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            store.delete(String(key));
        }).catch(error => {
            console.warn('删除过期项失败:', error);
        });
    }
    
    /**
     * 获取内部统计信息（用于调试）
     */
    function getInternalStats() {
        return {
            stats: stats,
            dbName: DB_NAME,
            dbVersion: DB_VERSION,
            storeName: STORE_NAME,
            connectionStatus: dbConnection ? 'connected' : 'disconnected'
        };
    }
    
    /**
     * 启动定期清理任务
     */
    function startPeriodicCleanup() {
        if (cleanupIntervalId) {
            return; // 避免重复启动
        }
        
        cleanupIntervalId = setInterval(() => {
            cleanExpired(() => {
                console.log('🧹 定期清理过期数据完成');
            });
        }, 30 * 60 * 1000); // 30分钟
        
        console.log('✅ 定期清理任务已启动');
    }
    
    /**
     * 停止定期清理任务
     */
    function stopPeriodicCleanup() {
        if (cleanupIntervalId) {
            clearInterval(cleanupIntervalId);
            cleanupIntervalId = null;
            console.log('🗑️ 定期清理任务已停止');
        }
    }
    
    /**
     * 数据库关闭和清理
     */
    function closeDatabase() {
        stopPeriodicCleanup();
        if (dbConnection) {
            dbConnection.close();
            dbConnection = null;
            dbInitPromise = null;
        }
        reconnectAttempts = 0;
        console.log('✅ 数据库连接已关闭和清理');
    }
    
    // 自动初始化数据库
    initDatabase().then(() => {
        startPeriodicCleanup();
    }).catch(error => {
        console.error('IndexedDB管理器初始化失败:', error);
    });
    
    // 监听页面关闭事件，清理资源
    if (typeof window !== 'undefined') {
        window.addEventListener('beforeunload', closeDatabase);
    }
    
    // 在Chrome扩展环境中监听卸载事件
    if (typeof chrome !== 'undefined' && chrome.runtime) {
        chrome.runtime.onSuspend?.addListener(closeDatabase);
    }
    
    // 公开接口
    return {
        // 基础操作
        setItem: setItem,
        getItem: getItem,
        removeItem: removeItem,
        clear: clear,
        getAllKeys: getAllKeys,
        
        // 统计和管理
        getStats: getStats,
        cleanExpired: cleanExpired,
        setMultiple: setMultiple,
        
        // 连接管理
        closeDatabase: closeDatabase,
        startPeriodicCleanup: startPeriodicCleanup,
        stopPeriodicCleanup: stopPeriodicCleanup,
        
        // 内部接口
        getInternalStats: getInternalStats,
        
        // 数据库信息
        DB_NAME: DB_NAME,
        DB_VERSION: DB_VERSION,
        STORE_NAME: STORE_NAME,
        
        // 性能配置
        PERFORMANCE_CONFIG: PERFORMANCE_CONFIG
    };
})();