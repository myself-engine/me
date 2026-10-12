// Local HTTP server for the bridge tests, on an ephemeral 127.0.0.1 port. No network.
export function startServer() {
  return Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(req) {
      const url = new URL(req.url);
      const p = url.pathname;
      if (p.startsWith("/echo")) {
        return Response.json({
          method: req.method,
          path: p,
          search: url.search,
          headers: { authorization: req.headers.get("authorization"), "x-id": req.headers.get("x-id"), "content-type": req.headers.get("content-type") },
          body: await req.text(),
        });
      }
      if (p === "/hello") return new Response("hello\n");
      if (p === "/big") return new Response("x".repeat(200_000));
      if (p === "/slow") {
        await Bun.sleep(5_000);
        return new Response("late");
      }
      if (p === "/missing") return new Response("no such thing", { status: 404 });
      if (p === "/redirect") return new Response(null, { status: 302, headers: { location: "http://elsewhere.invalid/" } });
      if (p === "/html") return new Response("<p>hi</p>", { headers: { "content-type": "text/html" } });
      return new Response("not found", { status: 404 });
    },
  });
}
