export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders() });
    }

    if (url.pathname === '/api/listing') {
      return handleListing(request);
    }

    if (url.pathname === '/api/image') {
      return handleImage(request);
    }

    return env.ASSETS.fetch(request);
  }
};

async function handleListing(request) {
  const { searchParams } = new URL(request.url);
  const listingUrl = searchParams.get('url');

  if (!listingUrl) {
    return json({ error: 'Missing url parameter' }, 400);
  }

  try {
    const res = await fetch(listingUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cache-Control': 'no-cache',
        'Upgrade-Insecure-Requests': '1',
      },
      redirect: 'follow',
    });

    if (!res.ok) return json({ error: `HTTP ${res.status} from listing site` }, 502);

    const html = await res.text();
    const data = parseListing(html, listingUrl);
    return json(data);
  } catch (e) {
    return json({ error: e.message }, 502);
  }
}

async function handleImage(request) {
  const { searchParams } = new URL(request.url);
  const imgUrl = searchParams.get('url');
  if (!imgUrl) return new Response('Missing url', { status: 400 });

  let parsed;
  try { parsed = new URL(imgUrl); } catch { return new Response('Invalid url', { status: 400 }); }

  const allowed = ['compass.com', 'ssl.cdn-redfin.com', 'photos.zillowstatic.com', 'ar.rdcpix.com', 'p.rdcpix.com', 'rdcpix.com'];
  if (!allowed.some(h => parsed.hostname.endsWith(h))) {
    return new Response('Domain not allowed', { status: 403 });
  }

  try {
    const res = await fetch(imgUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Referer': `https://${parsed.hostname}/`,
        'Accept': 'image/webp,image/apng,image/*,*/*;q=0.8',
      },
    });
    if (!res.ok) return new Response(`Image fetch failed: ${res.status}`, { status: 502 });
    const contentType = res.headers.get('Content-Type') || 'image/jpeg';
    return new Response(res.body, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400',
        'Access-Control-Allow-Origin': '*',
      },
    });
  } catch(e) {
    return new Response(e.message, { status: 502 });
  }
}

function parseListing(html, url) {
  const hostname = new URL(url).hostname.toLowerCase();
  const result = {
    price: null, address: null, beds: null, baths: null,
    sqft: null, photo: null, yearBuilt: null, description: null,
    lotSize: null, propertyType: null,
  };

  // ── 1. __NEXT_DATA__ (Compass, Zillow, Realtor.com, Redfin) ──────────────
  const nextMatch = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextMatch) {
    try {
      const nd = JSON.parse(nextMatch[1]);
      const pp = nd?.props?.pageProps;

      if (hostname.includes('compass')) {
        // Detail page: single listing
        const l = pp?.listing ?? pp?.listingData ?? pp?.initialProps?.listing;
        // Search results page: array of listings — take the first
        const listings = pp?.listings ?? pp?.searchResults?.listings
          ?? pp?.initialSearchContext?.listings ?? pp?.searchContext?.listings;
        const src = l ?? listings?.[0];
        if (src) {
          result.price       = src.listPrice ?? src.price;
          result.address     = src.displayAddress ?? src.streetAddress ?? src.fullAddress;
          result.beds        = src.bedrooms ?? src.bedroomCount ?? src.beds;
          result.baths       = src.bathrooms ?? src.bathroomCount ?? src.baths;
          result.sqft        = src.squareFeet ?? src.livingArea ?? src.floorSize;
          result.yearBuilt   = src.yearBuilt;
          result.photo       = src.photos?.[0]?.url ?? src.media?.[0]?.url ?? src.primaryPhoto;
          result.description = src.remarks ?? src.description;
          result.propertyType = src.propertyType ?? src.type;
        }
      }

      if (hostname.includes('zillow')) {
        // Zillow embeds property data in gdpClientCache as a stringified JSON map
        let bld = pp?.initialData?.building;
        if (!bld && pp?.gdpClientCache) {
          try {
            const cache = JSON.parse(pp.gdpClientCache);
            const first = JSON.parse(Object.values(cache)[0]);
            bld = first?.property ?? first?.building;
          } catch {}
        }
        if (bld) {
          result.price      = bld.price ?? bld.listingPrice ?? bld.zestimate;
          result.address    = bld.streetAddress ?? bld.address?.streetAddress;
          result.beds       = bld.bedrooms ?? bld.beds;
          result.baths      = bld.bathrooms ?? bld.baths;
          result.sqft       = bld.livingArea ?? bld.floorSize;
          result.yearBuilt  = bld.yearBuilt;
          result.photo      = bld.photos?.[0]?.url ?? bld.images?.[0];
          result.lotSize    = bld.lotSize;
          result.propertyType = bld.homeType ?? bld.propertyType;
        }
      }

      if (hostname.includes('realtor.com')) {
        const home = pp?.initialProps?.listing ?? pp?.homes?.[0] ?? pp?.property;
        if (home) {
          result.price      = home.list_price ?? home.price;
          result.address    = home.location?.address?.line;
          result.beds       = home.description?.beds ?? home.description?.beds_min;
          result.baths      = home.description?.baths_consolidated ?? home.description?.baths;
          result.sqft       = home.description?.sqft;
          result.yearBuilt  = home.description?.year_built;
          result.photo      = home.primary_photo?.href ?? home.photos?.[0]?.href;
          result.description = home.description?.text;
          result.propertyType = home.description?.type;
        }
      }

      if (hostname.includes('redfin')) {
        // Redfin puts data in initialInfo or serverSideData
        const info = pp?.serverSideData?.aboveTheFold ?? pp?.initialInfo;
        if (info) {
          result.price      = info.listingPrice?.amount ?? info.price?.amount;
          result.address    = info.streetAddress ?? info.address;
          result.beds       = info.beds;
          result.baths      = info.baths;
          result.sqft       = info.sqFt?.value ?? info.sqft;
          result.yearBuilt  = info.yearBuilt?.value ?? info.yearBuilt;
          result.photo      = info.mediaBrowserInfo?.photos?.[0]?.url;
          result.propertyType = info.propertyType;
        }
      }
    } catch {}
  }

  // ── 2. JSON-LD schema.org ─────────────────────────────────────────────────
  if (!result.price) {
    for (const m of html.matchAll(/<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/g)) {
      try {
        const items = [JSON.parse(m[1])].flat();
        for (const item of items) {
          const nodes = item['@graph'] ? [...item['@graph'], item] : [item];
          for (const node of nodes) {
            const price = node.offers?.price ?? node.price ?? node.listPrice;
            if (price && parseInt(String(price).replace(/\D/g, '')) > 10000) {
              result.price       = parseInt(String(price).replace(/\D/g, ''));
              result.address     = result.address ?? node.name ?? node.address?.streetAddress;
              result.photo       = result.photo ?? (Array.isArray(node.image) ? node.image[0] : node.image);
              result.beds        = result.beds ?? node.numberOfRooms;
              result.description = result.description ?? node.description;
              break;
            }
          }
          if (result.price) break;
        }
      } catch {}
      if (result.price) break;
    }
  }

  // ── 3. Inline JS state blobs ──────────────────────────────────────────────
  if (!result.price) {
    for (const pattern of [/"listPrice"\s*:\s*(\d{5,9})/, /"listingPrice"\s*:\s*(\d{5,9})/, /"asking_price"\s*:\s*(\d{5,9})/]) {
      const m = html.match(pattern);
      if (m) { result.price = parseInt(m[1]); break; }
    }
  }
  if (!result.beds) {
    const m = html.match(/"bedrooms?"\s*:\s*(\d+)/);
    if (m) result.beds = parseInt(m[1]);
  }
  if (!result.baths) {
    const m = html.match(/"bathrooms?"\s*:\s*([\d.]+)/);
    if (m) result.baths = parseFloat(m[1]);
  }
  if (!result.sqft) {
    const m = html.match(/"(?:squareFeet|livingArea|floorSize|sqft)"\s*:\s*([\d.]+)/);
    if (m) result.sqft = parseInt(m[1]);
  }

  // ── 4. OG / meta tags ────────────────────────────────────────────────────
  const ogGet = (prop) =>
    html.match(new RegExp(`<meta[^>]*property="${prop}"[^>]*content="([^"]+)"`))?.[1] ??
    html.match(new RegExp(`<meta[^>]*content="([^"]+)"[^>]*property="${prop}"`))?.[1];

  result.photo   = result.photo   ?? ogGet('og:image');
  result.address = result.address ?? ogGet('og:title');

  const desc = ogGet('og:description') ?? '';
  if (!result.beds)  { const m = desc.match(/(\d+)\s*(?:bed|br)\b/i);               if (m) result.beds  = parseInt(m[1]); }
  if (!result.baths) { const m = desc.match(/(\d+(?:\.\d+)?)\s*(?:bath|ba)\b/i);    if (m) result.baths = parseFloat(m[1]); }
  if (!result.sqft)  { const m = desc.match(/([\d,]+)\s*(?:sq\.?\s*ft|sqft)/i);     if (m) result.sqft  = parseInt(m[1].replace(/,/g,'')); }

  // Clean up
  if (result.price) result.price = parseInt(String(result.price).replace(/\D/g, ''));
  if (result.sqft)  result.sqft  = parseInt(String(result.sqft).replace(/\D/g, ''));

  return result;
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: corsHeaders() });
}

function corsHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}
