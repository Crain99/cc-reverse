/*
 * @Date: 2021-01-26 15:51:31
 */
const generator = require("@babel/generator");
const parser = require("@babel/parser");
const traverse = require("@babel/traverse");
const types = require("@babel/types");
const fs = require("fs");
const _path = require("path")
const uuid = require("./_uuid")
const decodeUuid = require("./decode")
const tool = require("./tools");
module.exports = {
    async splitCompile(code) {
        // 1.parse
        const ast = parser.parse(code);
        const values = [];
        // 2,traverse
        const findValue = {
            ArrayExpression(path) {
                const {
                    node
                } = path;
                if (node && node.elements) {
                    for (let i of node.elements) {
                        if (types.isStringLiteral(i)) {
                            values.push(i.value)
                        }
                    }
                }
            },
        };

        const splitVisitor = {
            Property(path) {
                const {
                    node
                } = path;
                if (values.length > 0) {
                    for (let value of values) {
                        if (node && (node.key.name == value || node.key.value == value) && node.value.elements) {
                            let _require = node.value.elements[0].params[0].name
                            let _module = node.value.elements[0].params[1].name
                            let _exports = node.value.elements[0].params[2].name
                            
                            let id1 = types.identifier(`${_require}`)
                            let id2 = types.identifier(`${_module}`)
                            let id3 = types.identifier(`${_exports}`)
                            let init1 = types.identifier("require")
                            let init2 = types.identifier("module")
                            let init3 = types.identifier("exports")
                            let variable1 = types.variableDeclarator(id1, init1);
                            let declaration1 = types.variableDeclaration("let", [variable1])
                            let variable2 = types.variableDeclarator(id2, init2);
                            let declaration2 = types.variableDeclaration("let", [variable2])
                            let variable3 = types.variableDeclarator(id3, init3);
                            let declaration3 = types.variableDeclaration("let", [variable3])
                            node.value.elements[0].body.body.unshift(declaration1, declaration2, declaration3)
                            for (let i of node.value.elements[0].body.body) {
                                //生成meta文件
                                if (i.type == 'ExpressionStatement') {
                                    if (i.expression.expressions) {
                                        for (let a of i.expression.expressions) {
                                            if (a.arguments && a.arguments.length == 3) {
                                                if (a.arguments[1]) {
                                                    if (a.arguments[1].type && a.arguments[1].type == "StringLiteral" && a.arguments[1].value != "__esModule") {
                                                        let filename = a.arguments[2].value.split('.')[0]+ ".ts"
                                                        
                                                        let fileMap = new Set()
                                                        fileMap[filename] = decodeUuid(uuid.original_uuid(a.arguments[1].value))
                                                        tool.convertToMetaFile(fileMap)
                                                    }
                                                }
                                            }
                                        }
                                    }
                                    if (i.expression.arguments && i.expression.arguments.length == 3) {
                                        if (i.expression.arguments[1]) {                                        
                                            if (i.expression.arguments[1].type && i.expression.arguments[1].type == "StringLiteral" && i.expression.arguments[1].value != "__esModule") {
                                                let filename = i.expression.arguments[2].value.split('.')[0] + ".ts"
                                                let fileMap = new Set()
                                                fileMap[filename] = decodeUuid(uuid.original_uuid(i.expression.arguments[1].value))
                                                tool.convertToMetaFile(fileMap)
                                            }
                                        }
                                    }
                                }
                                //处理导入路径
                                if (i.type == 'VariableDeclaration' && i.declarations) {
                                    for (let j of i.declarations) {
                                        if (j.init) {
                                            if (j.type == "VariableDeclarator" && j.init.arguments) {
                                                if (j.init.arguments[0] && j.init.arguments[0].value) {
                                                    j.init.arguments[0].value = _path.basename(j.init.arguments[0].value)
                                                }
                                            }
                                            if (j.type == "VariableDeclarator" && j.init.expressions) {
                                                for (let res of j.init.expressions) {
                                                    if (res.type == "CallExpression") {
                                                        if (res.arguments && res.arguments[0] && res.arguments[0].value) {
                                                            if (typeof res.arguments[0].value == "string") {
                                                                res.arguments[0].value = _path.basename(res.arguments[0].value)
                                                            }
                                                        }
                                                    }

                                                }
                                            }
                                        }
                                    }
                                }
                                if (i.type == 'ExpressionStatement' && i.expression) {
                                    if (i.expression.type == "CallExpression" && i.expression.arguments) {
                                        let res = i.expression.arguments
                                        if (res[0] && typeof res[0].value == "string") {
                                            res[0].value = _path.basename(res[0].value)
                                        }
                                    }
                                }
                                /*if (i.type == 'ExpressionStatement' && i.expression.arguments) {
                                    for (let j of i.expression.arguments) {
                                        if (j.type == "Identifier") {
                                            j.name = "exports"
                                        }
                                    }
                                }
                                if (i.type == 'ExpressionStatement' && i.expression) {
                                    if (i.expression && i.expression.type == 'SequenceExpression') {
                                        for (let j of i.expression.expressions) {
                                            if (j.type == 'AssignmentExpression') {
                                                j.left.object.name = "exports"
                                            }
                                        }
                                    }
                                }
                                if (i.type == 'ExpressionStatement' && i.expression) {
                                    if (i.expression && i.expression.type == 'CallExpression') {
                                        if (i.expression.callee.type == "Identifier") {
                                            i.expression.callee.name = "require"
                                        }
                                       
                                    }
                                }*/

                                /*if (i.type == 'VariableDeclaration' && i.declarations) {
                                    for (let j of i.declarations) {
                                        if (j.init) {
                                            
                                            if(j.type == "VariableDeclarator" && j.init.arguments){
                                                if(j.init.arguments[0] && j.init.arguments[0].value){
                                                    j.init.arguments[0].value = _path.basename(j.init.arguments[0].value)
                                                }
                                            }
                                            if (j.type == "VariableDeclarator" && j.init.callee) {
                                                if (j.init.callee["name"]) {
                                                    j.init.callee["name"] = "require"
                                                }
                                            }
                                            if (j.type == "VariableDeclarator" && j.init.expressions) {
                                                for (let value of j.init.expressions) {
                                                    if (value.callee && value.callee.type == "Identifier") {
                                                        if (value.callee.name == _require) {
                                                            value.callee.name = "require"
                                                        }
                                                    }
                                                }
                                                //console.log(j.init)
                                            }
                                        }

                                    }
                                }*/
                            }
                            let str = JSON.stringify(node.value.elements[0].body)
                            fs.mkdirSync('./astTree', {
                                recursive: true
                            }, (err) => {
                                if (err) {
                                    console.log(err);
                                }
                            })
                            fs.appendFileSync(`./astTree/${value}.json`, str, {
                                flag: 'w+'
                            }, (err) => {
                                if (err) {
                                    console.log(err)
                                }
                            });
                        }
                    }
                }
            }
        };
        await traverse.default(ast, findValue);
        await traverse.default(ast, splitVisitor);
    },
    generatorCode(ast, filename) {
        let res = generator.default(ast, {})["code"]
        fs.appendFile(`./project/assets/Scripts/${filename}.ts`, JSON.parse(JSON.stringify(res.slice(1, res.length - 1))), {
            encoding: "utf-8",
            flag: "w+"
        }, (err) => {
            if (err) {
                console.log(err)
            }
        })
        return generator.default(ast, {})
    }
}