// Test fixtures: a fake wlu.ca (sitemap, register page, policy pages) and a deterministic embedder.
import { REGISTER, SITEMAP } from "../src/sources.mjs";

export const BASE = "https://www.wlu.ca/about/governance/assets/resources/";

export function policyHtml({ title, revised = "June 2, 2024", sections }) {
  return `<html><head><title>${title} | Policies | Wilfrid Laurier University</title></head><body>
<nav><ul><li><a href="/">Home</a></li></ul></nav>
<main id="maincontent"><h1>${title}</h1>
<p><a href="#">Print</a> | <a href="#">PDF</a></p>
<p>This online version is for convenience; the official version of this policy is housed in the University Secretariat.</p>
<p>Approving Authority: Senate</p><p>Original Approval Date: May 1, 2000</p>
<p>Date of Most Recent Review/Revision: ${revised}</p><p>Office of Accountability: Provost and Vice-President: Academic</p>
${sections.map(([h, body]) => `<h2>${h}</h2>${body}`).join("\n")}
</main><footer>Contact us</footer></body></html>`;
}

// A mutable fake site: `pages` maps URL -> HTML; `listed` is what the sitemap lists.
export function fakeSite(pages) {
  const site = { pages: new Map(Object.entries(pages)), listed: null, fail: new Set(), requests: [] };
  site.get = async (url) => {
    site.requests.push(url);
    if (url === SITEMAP) {
      const urls = site.listed || [...site.pages.keys()];
      return { status: 200, url, text: `<urlset>${urls.map((u) => `<url><loc>${u}</loc><lastmod>2026-01-01</lastmod></url>`).join("")}</urlset>` };
    }
    if (url === REGISTER) return { status: 200, url, text: "<main><a href='/about/governance/policies.html'>Policies</a></main>" };
    if (site.fail.has(url)) return { status: 503, url, text: "" };
    const html = site.pages.get(url);
    return html ? { status: 200, url, text: html } : { status: 404, url, text: "" };
  };
  return site;
}

// Bag-of-words vectors: texts sharing words point the same way, so vector search behaves sensibly.
export function fakeEmbedder(dims = 64) {
  const e = {
    name: "fake",
    dims,
    calls: 0,
    texts: 0,
    async embed(texts) {
      e.calls++;
      e.texts += texts.length;
      return texts.map((t) => {
        const v = new Float32Array(dims);
        for (const w of t.toLowerCase().match(/[a-z]{3,}/g) || []) {
          let h = 0;
          for (const ch of w.slice(0, 6)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
          v[h % dims] += 1;
        }
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
  return e;
}

export const PAGES = {
  [`${BASE}12.2-student-code-of-conduct.html`]: policyHtml({
    title: "12.2 Student Code of Conduct: Academic Misconduct",
    sections: [
      ["1.00 Purpose", "<p>1.01 This policy sets out how academic misconduct is handled.</p>"],
      ["2.00 Definitions", "<p>2.01 Plagiarism: presenting the work of others as one's own.</p><p>2.02 Cheating: using unauthorized aids in a test.</p>"],
      ["4.00 Policy", "<p>4.01 Students are responsible for the integrity of their work.</p>"],
      ["5.00 Penalties", "<p>5.01 A first offence may result in a written warning or a zero on the work.</p>"],
      [
        "Appendix: Penalty Guidelines",
        `<table><caption>Plagiarism</caption><tbody><tr><th scope="col">Offences</th><th scope="col">First Offence</th><th scope="col">Second Offence</th></tr>
         <tr><th scope="row">Minor</th><td><ol><li>Written warning.</li><li>Resubmission.</li></ol></td><td><ol><li>Zero in the course.</li></ol></td></tr>
         <tr><th scope="row">Major</th><td><ol><li>Zero on the work.</li></ol></td><td><ol><li>Expulsion.</li></ol></td></tr></tbody></table>`,
      ],
    ],
  }),
  [`${BASE}9.3-classroom-use-of-electronic-devices.html`]: policyHtml({
    title: "9.3 Classroom Use of Electronic Devices",
    sections: [
      ["1.00 Purpose", "<p>1.01 This policy covers phones, laptops and other electronic devices in class.</p>"],
      ["3.00 Policy", "<p>3.01 Instructors may restrict the use of electronic devices during lectures and tests.</p>"],
    ],
  }),
  [`${BASE}procedures-for-student-code-of-conduct.html`]: policyHtml({
    title: "Procedures for Student Code of Conduct: Academic Misconduct",
    sections: [["2.00 Procedures", "<p>2.01 The instructor meets the student and completes the academic misconduct form.</p>"]],
  }),
};
