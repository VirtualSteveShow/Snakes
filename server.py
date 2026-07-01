import os
from aiohttp import web

HERE = os.path.dirname(os.path.abspath(__file__))
PUBLIC = os.path.join(HERE, 'public')


async def index_handler(request):
    return web.FileResponse(os.path.join(PUBLIC, 'index.html'))


async def static_handler(request):
    filename = request.match_info.get('filename', '')
    filepath = os.path.realpath(os.path.join(PUBLIC, filename))
    if not filepath.startswith(os.path.realpath(PUBLIC)):
        raise web.HTTPForbidden()
    if not os.path.isfile(filepath):
        raise web.HTTPNotFound()
    response = web.FileResponse(filepath)
    if filename == 'sw.js':
        response.headers['Cache-Control'] = 'no-store'
    elif filename.endswith(('.js', '.css', '.html')):
        response.headers['Cache-Control'] = 'no-cache'
    return response


app = web.Application()
app.router.add_get('/', index_handler)
app.router.add_get('/{filename:.+}', static_handler)

if __name__ == '__main__':
    import ssl

    port = int(os.environ.get('PORT', 8083))

    CERT = r'C:\ComfyUI_Portable\ComfyUI_Phone_App\tailscale.crt'
    KEY  = r'C:\ComfyUI_Portable\ComfyUI_Phone_App\tailscale.key'
    DOMAIN = 'desktop-rsghbik.tail60e4a8.ts.net'

    ssl_ctx = None
    if os.path.exists(CERT) and os.path.exists(KEY):
        ssl_ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ssl_ctx.load_cert_chain(CERT, KEY)

    scheme = 'https' if ssl_ctx else 'http'
    if not ssl_ctx:
        print('  WARNING: SSL cert not found — running HTTP')

    print(f'\n  Snake server')
    print(f'  Local:     {scheme}://localhost:{port}')
    print(f'  Tailscale: {scheme}://{DOMAIN}:{port}\n')

    web.run_app(app, host='0.0.0.0', port=port, ssl_context=ssl_ctx)
