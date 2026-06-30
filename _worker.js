// _worker.js - 最终版：删除响应头 CSP 和 HTML meta CSP
export default {
  async fetch(request) {
    return handleRequest(request);
  }
};

async function handleRequest(request) {
  try {
    const url = new URL(request.url);

    if (url.pathname === "/") {
      return finalizeResponse(new Response(getRootHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }));
    }

    let actualUrlStr = decodeURIComponent(url.pathname.replace("/", ""));
    actualUrlStr = ensureProtocol(actualUrlStr, url.protocol);
    actualUrlStr += url.search;

    const newHeaders = filterHeaders(request.headers, name => !name.startsWith('cf-'));
    if (newHeaders.has('Referer')) {
      try {
        const targetOrigin = new URL(actualUrlStr).origin;
        newHeaders.set('Referer', targetOrigin);
      } catch (e) {}
    }

    const modifiedRequest = new Request(actualUrlStr, {
      headers: newHeaders,
      method: request.method,
      body: request.body,
      redirect: 'manual'
    });

    const response = await fetch(modifiedRequest);

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      return finalizeResponse(handleRedirect(response));
    }

    const contentType = response.headers.get("Content-Type") || "";
    if (contentType.includes("text/html")) {
      const htmlResponse = await handleHtmlContent(response, url.protocol, url.host, actualUrlStr);
      return finalizeResponse(htmlResponse);
    }

    return finalizeResponse(response);

  } catch (error) {
    return jsonResponse({ error: error.message }, 500);
  }
}

// ========== 响应头处理：保留所有头，只删除危险头 ==========
function finalizeResponse(response) {
  const newHeaders = new Headers(response.headers);
  
  newHeaders.delete('Content-Security-Policy');
  newHeaders.delete('X-Frame-Options');
  newHeaders.delete('X-Content-Type-Options');
  // 也可能有其他类似头，可酌情删除
  // newHeaders.delete('Referrer-Policy');
  
  newHeaders.set('Cache-Control', 'no-store');
  newHeaders.set('Access-Control-Allow-Origin', '*');
  newHeaders.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  newHeaders.set('Access-Control-Allow-Headers', '*');

  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}

// ========== 辅助函数 ==========
function ensureProtocol(url, defaultProtocol) {
  if (url.startsWith("http://") || url.startsWith("https://")) {
    return url;
  }
  return defaultProtocol + "//" + url;
}

function handleRedirect(response) {
  const location = response.headers.get('location');
  if (!location) return response;
  try {
    const locationUrl = new URL(location);
    const modifiedLocation = `/${encodeURIComponent(locationUrl.toString())}`;
    const newHeaders = new Headers(response.headers);
    newHeaders.set('Location', modifiedLocation);
    return new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: newHeaders
    });
  } catch (e) {
    return response;
  }
}

// ========== HTMLRewriter 处理器（含 meta CSP 删除） ==========
async function handleHtmlContent(response, protocol, host, actualUrlStr) {
  const baseUrl = new URL(actualUrlStr).href;

  const rewriter = new HTMLRewriter()
    // === 删除 CSP meta 标签 ===
    .on('meta', {
      element(element) {
        const httpEquiv = element.getAttribute('http-equiv');
        if (httpEquiv && httpEquiv.toLowerCase() === 'content-security-policy') {
          element.remove();
        }
      }
    })
    // 处理链接
    .on('a', {
      element(element) {
        const href = element.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          try {
            const absolute = new URL(href, baseUrl).toString();
            element.setAttribute('href', `/${encodeURIComponent(absolute)}`);
          } catch (_) {}
        }
      }
    })
    .on('img', {
      element(element) {
        const src = element.getAttribute('src');
        if (src) {
          try {
            const absolute = new URL(src, baseUrl).toString();
            element.setAttribute('src', `/${encodeURIComponent(absolute)}`);
          } catch (_) {}
        }
        const srcset = element.getAttribute('srcset');
        if (srcset) {
          const newSrcset = srcset.split(',').map(part => {
            const [url, size] = part.trim().split(/\s+/);
            try {
              const absolute = new URL(url, baseUrl).toString();
              return `/${encodeURIComponent(absolute)}${size ? ' ' + size : ''}`;
            } catch (_) { return part; }
          }).join(', ');
          element.setAttribute('srcset', newSrcset);
        }
      }
    })
    .on('script', {
      element(element) {
        const src = element.getAttribute('src');
        if (src) {
          try {
            const absolute = new URL(src, baseUrl).toString();
            element.setAttribute('src', `/${encodeURIComponent(absolute)}`);
          } catch (_) {}
        }
      }
    })
    .on('link', {
      element(element) {
        const href = element.getAttribute('href');
        if (href) {
          try {
            const absolute = new URL(href, baseUrl).toString();
            element.setAttribute('href', `/${encodeURIComponent(absolute)}`);
          } catch (_) {}
        }
      }
    })
    .on('style', {
      text(text) {
        const css = text.text;
        const newCss = css.replace(/url\((['"]?)([^'"()]+)(['"]?)\)/g, (match, q1, url, q2) => {
          try {
            const absolute = new URL(url, baseUrl).toString();
            return `url(${q1}/${encodeURIComponent(absolute)}${q2})`;
          } catch (_) {
            return match;
          }
        });
        text.replace(newCss);
      }
    })
    .on('*', {
      element(element) {
        const style = element.getAttribute('style');
        if (style) {
          const newStyle = style.replace(/url\((['"]?)([^'"()]+)(['"]?)\)/g, (match, q1, url, q2) => {
            try {
              const absolute = new URL(url, baseUrl).toString();
              return `url(${q1}/${encodeURIComponent(absolute)}${q2})`;
            } catch (_) {
              return match;
            }
          });
          element.setAttribute('style', newStyle);
        }
      }
    });

  return rewriter.transform(response);
}

function jsonResponse(data, status) {
  return new Response(JSON.stringify(data), {
    status: status,
    headers: { 'Content-Type': 'application/json; charset=utf-8' }
  });
}

function filterHeaders(headers, filterFunc) {
  return new Headers([...headers].filter(([name]) => filterFunc(name)));
}

function getRootHtml() {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <link href="https://s4.zstatic.net/ajax/libs/materialize/1.0.0/css/materialize.min.css" rel="stylesheet">
  <title>Proxy Everything</title>
  <link rel="icon" type="image/png" href="https://s2.hdslb.com/bfs/openplatform/1682b11880f5c53171217a03c8adc9f2e2a27fcf.png@100w.webp">
  <meta name="Description" content="Proxy Everything with CF Workers.">
  <meta property="og:description" content="Proxy Everything with CF Workers.">
  <meta property="og:image" content="https://s2.hdslb.com/bfs/openplatform/1682b11880f5c53171217a03c8adc9f2e2a27fcf.png@100w.webp">
  <meta name="robots" content="index, follow">
  <meta http-equiv="Content-Language" content="zh-CN">
  <meta name="copyright" content="Copyright © ymyuuu">
  <meta name="author" content="ymyuuu">
  <link rel="apple-touch-icon-precomposed" sizes="120x120" href="https://s2.hdslb.com/bfs/openplatform/1682b11880f5c53171217a03c8adc9f2e2a27fcf.png@100w.webp">
  <meta name="apple-mobile-web-app-capable" content="yes">
  <meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
  <meta name="viewport" content="width=device-width, user-scalable=no, initial-scale=1.0, maximum-scale=1.0, minimum-scale=1.0, user-scalable=no">
  <style>
      body, html { height: 100%; margin: 0; }
      .background {
          background-size: cover;
          background-position: center;
          height: 100%;
          display: flex;
          align-items: center;
          justify-content: center;
      }
      .card {
          background-color: rgba(255, 255, 255, 0.8);
          transition: background-color 0.3s ease, box-shadow 0.3s ease;
      }
      .card:hover {
          background-color: rgba(255, 255, 255, 1);
          box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.3);
      }
      .input-field input[type=text] { color: #2c3e50; }
      .input-field input[type=text]:focus+label { color: #2c3e50 !important; }
      .input-field input[type=text]:focus {
          border-bottom: 1px solid #2c3e50 !important;
          box-shadow: 0 1px 0 0 #2c3e50 !important;
      }
      @media (prefers-color-scheme: dark) {
          body, html { background-color: #121212; color: #e0e0e0; }
          .card {
              background-color: rgba(33, 33, 33, 0.9);
              color: #ffffff;
          }
          .card:hover {
              background-color: rgba(50, 50, 50, 1);
              box-shadow: 0px 8px 16px rgba(0, 0, 0, 0.6);
          }
          .input-field input[type=text] { color: #ffffff; }
          .input-field input[type=text]:focus+label { color: #ffffff !important; }
          .input-field input[type=text]:focus {
              border-bottom: 1px solid #ffffff !important;
              box-shadow: 0 1px 0 0 #ffffff !important;
          }
          label { color: #cccccc; }
      }
  </style>
</head>
<body>
  <div class="background">
      <div class="container">
          <div class="row">
              <div class="col s12 m8 offset-m2 l6 offset-l3">
                  <div class="card">
                      <div class="card-content">
                          <span class="card-title center-align"><i class="material-icons left">link</i>Proxy Everything</span>
                          <form id="urlForm" onsubmit="redirectToProxy(event)">
                              <div class="input-field">
                                  <input type="text" id="targetUrl" placeholder="在此输入目标地址" required>
                                  <label for="targetUrl">目标地址</label>
                              </div>
                              <button type="submit" class="btn waves-effect waves-light teal darken-2 full-width">跳转</button>
                          </form>
                      </div>
                  </div>
              </div>
          </div>
      </div>
  </div>
  <script src="https://s4.zstatic.net/ajax/libs/materialize/1.0.0/js/materialize.min.js"></script>
  <script>
      function redirectToProxy(event) {
          event.preventDefault();
          const targetUrl = document.getElementById('targetUrl').value.trim();
          const currentOrigin = window.location.origin;
          window.open(currentOrigin + '/' + encodeURIComponent(targetUrl), '_blank');
      }
  </script>
</body>
</html>`;
}