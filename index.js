import babel from "@babel/core";
import repl from "repl";
import { Readable, Writable } from "stream";
import {promises as fs} from "fs";
import crypto from "crypto";
import Path from "path";

const isEmpty = function(obj){
    for(let key in obj){
        return false;
    }
    return true;
};

const toReplablePlugin = (ctx)=>(()=>({
    visitor: {
        ImportDeclaration(path) {
            path.skip();
            const {node} = path;
            const {specifiers,source} = node;
            const sourceName = JSON.stringify(source.value);
            const names = {};
            let namespace = null;
            for(let sp of specifiers){
                if(sp.type === "ImportDefaultSpecifier"){
                    names["default"] = sp.local.name;
                }else if(sp.type === "ImportSpecifier"){
                    names[sp.imported.name] = sp.local.name;
                }else if(sp.type === "ImportNamespaceSpecifier"){
                    namespace = sp.local.name;
                }
            }
            const namesString = `{${Object.entries(names).map(([a,b])=>`${a}: ${b}`).join(", ")}}`;
            let res;
            if(isEmpty(names) && namespace !== null){
                res = `const ${namespace} = await import(${sourceName});`;
            }else if(namespace === null){
                res = `const ${namesString} = await import(${sourceName});`;
            }else{
                res = `const [${namesString}, ${namespace}] = (async ()=>{const r = await import(${sourceName}); return [r,r]; })();`
            }
            // Replacing the old node
            const newNode = babel.parse(res).program.body[0];
            path.replaceWith(newNode);
        },
        ExportDefaultDeclaration(path) {
            path.skip();
            const {node} = path;
            path.replaceWith(node.declaration);
        },
        ExportNamedDeclaration(path) {
            path.skip();
            const {node} = path;
            path.replaceWith(node.declaration);
        },
        MetaProperty(path) {
            const {node} = path;
            if(node.meta.name !== "import" || node.property.name !== "meta"){
                return;
            }
            path.skip();
            path.replaceWith(babel.parse(`_${ctx.uuid}_import_meta`).program.body[0]);
            ctx.import_meta = true;
        }
    }
}));

const toReplable = function(code,ctx){
    const output = babel.transformSync(code, {
        plugins: [
            toReplablePlugin(ctx)
        ]
    });
    let res = "";
    if(ctx.import_meta && !ctx.import_meta_written){
        res += `const _${ctx.uuid}_import_meta = {url:"${new URL(ctx.filename,"file://").href}"};\n`;
        ctx.import_meta_written = true;
    }
    res += output.code;
    
    return res;
};

const createESMRepl = function(repl,ctx){
    const repleval = repl.eval.bind(repl);
    repl.eval = (code, context, file, cb)=>{
        let newCode;
        try{
            newCode = toReplable(code,ctx);
        }catch(err){
            return cb(err);
        }
        //console.log(typeof file,file,cb);
        return repleval(newCode, context, file, cb);
    }
    return repl;
};







const files = process.argv.slice(2);


let bgRepl = repl.start({
    prompt: "",
    input: new Readable({
        read() {}
    }),
    output: /*process.stdout,*/new Writable({
        write() {}
    }),
    useGlobal: true,
    writer: (output)=>{
        bgRepl.emit("error",output);
        return output;
    }
});

bgRepl.execFile = async function(_filename,header=""){
    const filename = Path.resolve(_filename);
    ctx = {
        uuid: crypto.randomUUID().replace(/\-/g,"_"),
        dirname: Path.dirname(filename),
        filename: filename,
    };
    let code = header;
    try{
        code += toReplable(""+await fs.readFile(filename),ctx)+"\n";
    }catch(err){
        //replacing the "unknown" filename at babel error with the actual file name
        console.log(err.message.replace("unknown",_filename));
        process.exit();
    }
    code += `throw new Error("success_${ctx.uuid}");`;
    //console.log(`@@@\n${code}\n@@@`);
    bgRepl.eval(code,global,`REPL_${ctx.uuid}`,()=>{});
    while(true){
        const r = await new Promise(res=>bgRepl.once("error",res));
        if(!(r instanceof Error))continue;
        if(r.message !== `success_${ctx.uuid}`){
            r.stack = r.stack || "";
            let match = r.stack.match(new RegExp(`at REPL_${ctx.uuid}:[0-9]+:[0-9]+`));
            //console.log(match);
            if(!match){
                console.log(r.message);
                console.log(r.stack);
                process.exit();
            }
            //working on generating a prettier error using babel source map
            match = match[0];
            const [line, pos] = match.match(/:([0-9]+):([0-9]+)$/).slice(1);
            //console.log(line,pos);
            //console.log(r.message);
            console.log(r.stack.replace(match,`at ${_filename}:${line-1}:${pos}`));
            process.exit();
        }
        break;
    }
};

let ctx = {
    uuid: crypto.randomUUID().replace(/\-/g,"_"),
    dirname: Path.resolve("."),
    filename: undefined
};

//loading files to the background repl
if(files[0] === "--native"){
    await bgRepl.execFile(
        files[1],
        `process.argv = ${JSON.stringify([process.argv[0],...files.slice(1)])};`);
}else{
    for(let i = 0; i < files.length; i++){
        await bgRepl.execFile(files[i]);
    }
}


bgRepl.eval(`
if(typeof __dirname === "undefined"){
    __dirname = ${JSON.stringify(ctx.dirname)};
}
if(typeof __filename === "undefined"){
    __filename = ${JSON.stringify(ctx.filename)};
}
`,global,`REPL0`,()=>{});
/*global.__dirname = ctx.dirname;
global.__filename = ctx.filename;
*/

const mainRepl = createESMRepl(repl.start({
    prompt:"> ",
    useGlobal:true,
    breakEvalOnSigint:true
}),ctx);


if("NODE_REPL_HISTORY" in process.env && process.env.NODE_REPL_HISTORY !== "")mainRepl.setupHistory(process.env.NODE_REPL_HISTORY,()=>{});


