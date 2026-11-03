const {DatabaseSync}=require('node:sqlite');
const http=require('node:http');
const [mode,file]=process.argv.slice(2);
const db=new DatabaseSync(file,{readOnly:mode==='read'});
if(mode==='read'){
 console.log(JSON.stringify(db.prepare('SELECT id, state FROM orders WHERE id = ?').get(1)));
}else{
 db.exec("CREATE TABLE orders(id INTEGER PRIMARY KEY,state TEXT NOT NULL); INSERT INTO orders VALUES(1,'paid')");
 http.createServer((req,res)=>{
  if(!['/','/api/orders/1'].includes(req.url)){res.writeHead(404).end();return;}
  const order=db.prepare('SELECT id,state FROM orders WHERE id=?').get(1);
  if(req.url==='/'){res.writeHead(200,{'Content-Type':'text/html'}).end('<h1>Order 1</h1><p role="status">'+order.state+'</p>');}
  else{res.writeHead(200,{'Content-Type':'application/json'}).end(JSON.stringify(order));}
 }).listen(0,'127.0.0.1',function(){console.log(this.address().port);});
}
