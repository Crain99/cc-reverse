/*
 * @Date: 2021-01-22 15:06:14
 */
const fs = require('fs')
const path = require('path')
const stringRandom = require('string-random')
global.currPath = String.raw `C:\Users\admin\Desktop\putao-main\res` //定义全局res路径
const settings = fs.readFileSync(String.raw `C:\Users\admin\Desktop\putao-main\src\settings.js`) //setting路径
const project = fs.readFileSync(String.raw `C:\Users\admin\Desktop\putao-main\src\project.js`) ///project路径
const tool = require("./tools")
const analysis = require('./analysis');
const decode = require('./decode');
const code = project.toString('utf-8');
let _ccsettings = "let window = {CCSettings: {}};" + settings.toString('utf-8').split(';')[0]
global.Settings = eval(_ccsettings)
global.filePath = String.raw `F:\cc-project-reverse\astTree`
fs.mkdirSync(global.filePath, {
    recursive: true
})

function delete_dir(dirPath) {
    if (fs.existsSync(dirPath)) {
        fs.readdirSync(dirPath).forEach(function (file) {
            let curPath = path.join(dirPath, file);
            if (fs.statSync(curPath).isDirectory()) {
                delete_dir(curPath);
            } else {
                fs.unlinkSync(curPath);
            }
        });
        fs.rmdirSync(dirPath);
    }
}
//读取插件列表
let jsList = global.Settings["jsList"]
if (jsList) {
    for (let i of jsList) {
        tool.cacheReadList.push(path.dirname(global.currPath) + `/src/` + i)
        let _mkdir = "Scripts/plugin/"
        let str = `./project/assets/${_mkdir}` + path.basename(i).split(".")[0] + ".js"
        tool.cacheWriteList.push(str)
        let meta = {
            "ver": "1.0.8",
            "uuid": decode(stringRandom(22)),
            "isPlugin": true,
            "loadPluginInWeb": true,
            "loadPluginInNative": true,
            "loadPluginInEditor": false,
            "subMetas": {}
        }
        tool.writeFile(_mkdir, path.basename(i).split('.')[0] + '.js' + ".meta", meta)
    }
}
analysis.splitCompile(code).then(() => {
    const res = fs.readdirSync(global.filePath)
    for (let i of res) {
        let currPath = path.join(global.filePath, i)
        const currFile = fs.readFileSync(currPath);
        let key = path.basename(currPath).split('.')[0]
        analysis.generatorCode(JSON.parse(currFile), key)
    }
    tool.init()
    delete_dir(global.filePath)
}).catch(err => {
    console.log(err)
})