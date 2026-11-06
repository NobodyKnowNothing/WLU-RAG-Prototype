// How an indexed chunk is cited. No imports, so the Worker can bundle it without Node built-ins.

// "12.2 Student Code of Conduct: Academic Misconduct > 4.01 Academic Misconduct, 4.02.03–4.02.07".
// The clause range is left out when the section heading already is that clause.
export function citationOf({ title, section, clauses }) {
  const showClauses = clauses && !String(section).split(" > ").at(-1).startsWith(`${clauses} `);
  return `${title} > ${section}${showClauses ? `, ${clauses}` : ""}`;
}

const AUTHORITY = { policy: "university policy", calendar: "Academic Calendar", guidance: "guidance page" };
export const authorityLabel = (a) => AUTHORITY[a] || AUTHORITY.guidance;
