/**
 * Routes for the website admin (/admin/) and the public files it manages.
 *
 *   Public:  GET /api/partners, /partner-logos/<id>.<ext>, /site-photos/<id>.<ext>,
 *            /testimonial-images/<id>.<ext>
 *   Admin:   /api/admin/session | login | logout          (src/admin-lib.js)
 *            /api/admin/partners | logos                    (src/partners.js)
 *            /api/admin/photos | photos/upload              (src/photos.js)
 *            /api/admin/testimonials | testimonials/upload  (src/testimonials.js)
 *
 * Every admin route except session and login needs a signed-in session, and anything that
 * changes data also needs a same-site Origin header.
 */
import { adminConfigured, json, login, logout, sameOrigin, validSession } from './admin-lib.js';
import { adminPartners, partnerLogo, publicPartners, savePartners, uploadPartnerLogo } from './partners.js';
import { adminPhotos, savePhotos, sitePhoto, uploadPhoto } from './photos.js';
import { adminTestimonials, saveTestimonials, testimonialImage, uploadTestimonialImage } from './testimonials.js';

export function isSitePath(pathname) {
  return pathname === '/api/partners' || pathname.startsWith('/api/admin/')
    || pathname.startsWith('/partner-logos/') || pathname.startsWith('/site-photos/') || pathname.startsWith('/testimonial-images/');
}

export async function siteRoute(request, env, ctx) {
  const { pathname } = new URL(request.url);
  const method = request.method;
  const read = method === 'GET' || method === 'HEAD';
  try {
    if (pathname === '/api/partners' && read) return publicPartners(request, env, ctx);
    if (pathname.startsWith('/partner-logos/') && read) return partnerLogo(pathname, env);
    if (pathname.startsWith('/site-photos/') && read) return sitePhoto(pathname, env);
    if (pathname.startsWith('/testimonial-images/') && read) return testimonialImage(pathname, env);
    if (!pathname.startsWith('/api/admin/')) return json({ error: 'not_found' }, 404);

    const route = pathname.slice('/api/admin/'.length);
    const configured = adminConfigured(env);
    if (route === 'session' && method === 'GET') {
      return json({ configured, signedIn: configured && await validSession(request, env) });
    }
    if (!configured) return json({ error: 'not_configured' }, 503);
    if (!read && !sameOrigin(request)) return json({ error: 'bad_origin' }, 403);
    if (route === 'login' && method === 'POST') return login(request, env);
    if (route === 'logout' && method === 'POST') return logout();

    if (!await validSession(request, env)) return json({ error: 'signed_out' }, 401);
    if (route === 'partners' && method === 'GET') return adminPartners(env);
    if (route === 'partners' && method === 'PUT') return savePartners(request, env, ctx);
    if (route === 'logos' && method === 'POST') return uploadPartnerLogo(request, env);
    if (route === 'photos' && method === 'GET') return adminPhotos(request, env);
    if (route === 'photos' && method === 'PUT') return savePhotos(request, env);
    if (route === 'photos/upload' && method === 'POST') return uploadPhoto(request, env);
    if (route === 'testimonials' && method === 'GET') return adminTestimonials(env);
    if (route === 'testimonials' && method === 'PUT') return saveTestimonials(request, env);
    if (route === 'testimonials/upload' && method === 'POST') return uploadTestimonialImage(request, env);
    return json({ error: 'not_found' }, 404);
  } catch (err) {
    console.error('admin:', err && err.stack ? err.stack : String(err));
    return json({ error: 'server_error' }, 500);
  }
}
