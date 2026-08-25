# Cover letters that read the way I want mine to.
# Paste your own here — real ones you have sent, or ones you have edited into
# the shape you like. The AI copies the tone and structure, never the content.
#
# Separate each with a line of three dashes. Delete these two if you would
# rather start from your own.

Your GA4 is almost certainly double-counting purchases if the thank-you page fires on reload — that is the usual cause of the gap between Shopify orders and GA4 revenue. I would start by auditing the GTM container and the dataLayer push on the confirmation step, then confirm against a raw BigQuery export so we are measuring against something authoritative. I have built this exact fix for Shopify and WooCommerce stores, and 50+ Looker Studio dashboards on top of the cleaned-up data. Are you running server-side GTM, or is everything client-side at the moment?

---

Attribution that disagrees between Meta and GA4 is normally a Conversions API setup sending a different event ID than the pixel, so the two never dedupe. I would check the CAPI payload first, match it against the pixel events, and get deduplication working before touching anything in reporting — otherwise the dashboard just makes the disagreement prettier. I have done this for ecommerce and lead-gen clients, and can put the result into Looker Studio so you can see both sources side by side. What is your current event volume, and are you sending CAPI through a server container or a third-party connector?
