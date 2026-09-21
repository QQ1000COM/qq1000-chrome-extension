 
    (function(){
        let custom_Json = localStorage.getItem("kdds_taobao_Json");
        if (custom_Json) {
            alert('进来了？')
            custom_Json = JSON.parse(custom_Json)
            let _Json = {}
            Object.defineProperty(window, 'Json', {
                configurable: true,
                enumerable: true,
                get: function () {
                    return _Json;
                },
                set: function (val) { 
                    _Json = custom_Json;
                }
            })
            Object.defineProperty(window, 'Json2', {
                configurable: true,
                enumerable: true,
                get: function () {
                    return _Json;
                },
                set: function (val) {  
                    for(let key of Object.keys(val.components)){
                        if(custom_Json.components[key]){
                            val.components[key] = custom_Json.components[key]
                        }
                    }
                    val.models.formValues = custom_Json.models.formValues;
                    _Json = val;
                }
            })
        }
    })()