const http = require('node:http');
const os = require('node:os');

const port = Number(process.env.PORT ?? 3000);

const server = http.createServer((request, response) => {
  response.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' });
  response.end(
    [
      'macdevcontainer example is running.',
      `host: ${os.hostname()}`,
      `path: ${request.url}`,
      '',
    ].join('\n'),
  );
});

server.listen(port, '0.0.0.0', () => {
  console.log(`Listening on http://localhost:${port}`);
});
