import {spawn} from 'node:child_process';
import readline from 'node:readline';
const server=JSON.parse(process.argv[2]),request=JSON.parse(process.argv[3]);
const child=spawn(server.command,server.args,{env:{...process.env,...Object.fromEntries(server.env.map(e=>[e.name,e.value]))},stdio:['pipe','pipe','inherit']});
const timeout=setTimeout(()=>{child.kill();process.exit(2);},10000);
child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',clientInfo:{name:'fixture',version:'1'}}})+'\n');
for await(const line of readline.createInterface({input:child.stdout})) {
 const response=JSON.parse(line);
 if(response.id===1){child.stdin.write(JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized'})+'\n');child.stdin.write(JSON.stringify({jsonrpc:'2.0',id:2,...request})+'\n');}
 else if(response.id===2){console.log(JSON.stringify(response));clearTimeout(timeout);child.kill();process.exit(0);}
}
