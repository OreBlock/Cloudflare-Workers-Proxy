// _worker.js - 最终修复：处理相对路径 + 默认域名兜底
export default {
  async fetch(request) {
    return handleRequest(request);
  }
};

// 默认目标域名（洛谷）
const DEFAULT_ORIGIN = 'https://www.luogu.com.cn';

async function handleRequest(request) {
  try {
    const url = new URL(request.url);

    // 根目录返回首页
    if (url.pathname === "/") {
      return finalizeResponse(new Response(getRootHtml(), {
        headers: { 'Content-Type': 'text/html; charset=utf-8' }
      }));
    }

    // ----- 解析目标 URL（兼容编码绝对路径和相对路径） -----
    let rawPath = decodeURIComponent(url.pathname.substring(1)); // 去掉第一个 '/'
    let actualUrlStr = rawPath;

    // 尝试从 Referer 中提取基础 URL（仅当请求不是完整 URL）
    if (!actualUrlStr.startsWith("http://") && !actualUrlStr.startsWith("https://")) {
      let baseOrigin = null;
      const referer = request.headers.get('Referer');
      if (referer) {
        try {
          const refererUrl = new URL(referer);
          const path = refererUrl.pathname; // 如 /https%3A%2F%2Fwww.luogu.com.cn%2F
          if (path.startsWith('/')) {
            const decoded = decodeURIComponent(path.substring(1));
            if (decoded.startsWith("http://") || decoded.startsWith("https://")) {
              baseOrigin = new URL(decoded).origin;
            }
          }
        } catch (e) {}
      }
      // 如果 Referer 解析失败，使用默认域名
      if (!baseOrigin) {
        baseOrigin = DEFAULT_ORIGIN;
      }
      // 拼接相对路径
      actualUrlStr = baseOrigin + (actualUrlStr.startsWith('/') ? '' : '/') + actualUrlStr;
    }

    // 附加查询参数
    if (url.search) actualUrlStr += url.search;

    // ----- 构造转发请求，强制设置 Referer 和 Origin -----
    const newHeaders = filterHeaders(request.headers, name => !name.startsWith('cf-'));
    try {
      const targetOrigin = new URL(actualUrlStr).origin;
      newHeaders.set('Referer', targetOrigin);
      newHeaders.set('Origin', targetOrigin);
    } catch (e) {}

    const modifiedRequest = new Request(actualUrlStr, {
      headers: newHeaders,
      method: request.method,
      body: request.body,
      redirect: 'manual'
    });

    const response = await fetch(modifiedRequest);

    // 处理重定向
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      return finalizeResponse(handleRedirect(response));
    }

    const contentType = response.headers.get("Content-Type") || "";

    // 处理 HTML
    if (contentType.includes("text/html")) {
      const htmlResponse = await handleHtmlContent(response, url.protocol, url.host, actualUrlStr);
      return finalizeResponse(htmlResponse);
    }

    // 处理 CSS
    if (contentType.includes("text/css")) {
      const cssResponse = await handleCssContent(response, actualUrlStr);
      return finalizeResponse(cssResponse);
    }

    // 其他资源
    return finalizeResponse(response);

  } catch (error) {
    console.error(error);
    return jsonResponse({ error: error.message }, 500);
  }
}

// ========== 响应头处理 ==========
function finalizeResponse(response) {
  const newHeaders = new Headers(response.headers);
  newHeaders.delete('Content-Security-Policy');
  newHeaders.delete('X-Frame-Options');
  newHeaders.delete('X-Content-Type-Options');
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

// ========== 重定向 ==========
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

// ========== CSS 重写（url() 和 @import） ==========
async function handleCssContent(response, cssUrl) {
  const baseUrl = cssUrl; // 完整的 CSS 文件 URL
  const originalText = await response.text();

  // 替换 url(...)
  let newText = originalText.replace(/url\((['"]?)([^'"()]+)(['"]?)\)/g, (match, q1, path, q2) => {
    try {
      if (path.startsWith('http://') || path.startsWith('https://') || path.startsWith('data:')) {
        return match;
      }
      const absolute = new URL(path, baseUrl).href;
      const proxied = `/${encodeURIComponent(absolute)}`;
      return `url(${q1}${proxied}${q2})`;
    } catch (e) {
      // 如果解析失败，尝试用默认域名拼接
      try {
        const absolute = new URL(path, DEFAULT_ORIGIN).href;
        const proxied = `/${encodeURIComponent(absolute)}`;
        return `url(${q1}${proxied}${q2})`;
      } catch (_) {
        return match;
      }
    }
  });

  // 处理 @import "path"
  newText = newText.replace(/@import\s+['"]([^'"]+)['"]/g, (match, path) => {
    try {
      if (path.startsWith('http://') || path.startsWith('https://')) {
        return match;
      }
      const absolute = new URL(path, baseUrl).href;
      const proxied = `/${encodeURIComponent(absolute)}`;
      return `@import "${proxied}"`;
    } catch (e) {
      return match;
    }
  });

  return new Response(newText, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

// ========== HTML 重写（删除 CSP meta + 替换资源链接） ==========
async function handleHtmlContent(response, protocol, host, actualUrlStr) {
  const baseUrl = new URL(actualUrlStr).href;

  const rewriter = new HTMLRewriter()
    .on('meta', {
      element(element) {
        const httpEquiv = element.getAttribute('http-equiv');
        if (httpEquiv && httpEquiv.toLowerCase() === 'content-security-policy') {
          element.remove();
        }
      }
    })
    .on('a', {
      element(element) {
        const href = element.getAttribute('href');
        if (href && !href.startsWith('#') && !href.startsWith('javascript:')) {
          try {
            const absolute = new URL(href, baseUrl).href;
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
            const absolute = new URL(src, baseUrl).href;
            element.setAttribute('src', `/${encodeURIComponent(absolute)}`);
          } catch (_) {}
        }
        const srcset = element.getAttribute('srcset');
        if (srcset) {
          const newSrcset = srcset.split(',').map(part => {
            const [url, size] = part.trim().split(/\s+/);
            try {
              const absolute = new URL(url, baseUrl).href;
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
            const absolute = new URL(src, baseUrl).href;
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
            const absolute = new URL(href, baseUrl).href;
            element.setAttribute('href', `/${encodeURIComponent(absolute)}`);
          } catch (_) {}
        }
      }
    })
    .on('style', {
      text(text) {
        const css = text.text;
        const newCss = css.replace(/url\((['"]?)([^'"()]+)(['"]?)\)/g, (match, q1, path, q2) => {
          try {
            const absolute = new URL(path, baseUrl).href;
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
          const newStyle = style.replace(/url\((['"]?)([^'"()]+)(['"]?)\)/g, (match, q1, path, q2) => {
            try {
              const absolute = new URL(path, baseUrl).href;
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

// ========== 工具 ==========
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