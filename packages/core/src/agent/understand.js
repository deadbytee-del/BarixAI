// Barix task understanding: a fast, deterministic analysis of what the user wants, run BEFORE any
// model call. It decides intent, which tool groups to expose, whether code/history retrieval and
// execution/verification are needed, response length, and expected output size. (A model-assisted
// classifier can refine ambiguous cases, but the baseline never costs an inference.)
const has = (re, t) => re.test(t);
const CODE_VERB = /\b(implement|fix|add|create|build|write|refactor|debug|rename|update|change|remove|delete|make|rewrite|migrate|convert|optimi[sz]e|port|install|set ?up|scaffold|generate|patch|edit|move|extract|integrate)\b/i;
const CODE_NOUN = /\b(function|class|method|component|module|file|files|bug|test|tests|app|page|website|site|css|html|api|endpoint|script|code|error|exception|project|repo|repository|package|dependency|bundle|build|lint|type|interface|variable|import|export|route|button|form|layout|database|schema|query|server|client|cli|config)\b/i;
const FILEISH = /[\w./@-]+\.(?:js|jsx|ts|tsx|mjs|cjs|py|go|rs|java|c|cc|cpp|h|hpp|cs|rb|php|css|scss|html|json|ya?ml|toml|md|sh|sql|vue|svelte)\b/gi;
const ERRORISH = /\b(bug|bugs|error|exception|traceback|stack ?trace|failing|fails|failed|crash\w*|broken|doesn'?t work|not working|undefined is not|cannot read|TypeError|ReferenceError|SyntaxError|segfault|panic)\b/i;
const REFERS_BACK = /\b(earlier|before|previous(?:ly)?|we (?:discussed|decided|talked|agreed)|as i (?:said|mentioned)|you (?:said|mentioned|told)|last time|again|that (?:file|function|bug|issue|change)|remember when|originally|back when)\b/i;
const EXEC = /\b(run|execute|test|tests|build|compile|lint|typecheck|start|launch|benchmark|install)\b/i;
const URL_RE = /https?:\/\/[^\s)>\]]+/gi;
const GH = /(?:https?:\/\/)?github\.com\/([\w.-]+)\/([\w.-]+)(?:\/(?:tree|blob|pull|issues|commit|releases)\/?[^\s)]*)?|\b([\w.-]+)\/([\w.-]+)#(\d+)\b|\b(pull request|issue|commit|branch|release|repo(?:sitory)?)\b/gi;
const PUBLISH = /\b(publish|deploy|push (?:it |this |the project )?to github|github pages|gh-pages|release|ship it|go live|upload to github)\b/i;
const VISION = /\b(screenshot|mock-?up|image|picture|photo|diagram|chart|figure|this (?:design|ui|page|screen)|looks? like|pixel|wireframe)\b/i;
const CONCISE = /\b(brief(?:ly)?|short(?:ly)?|tl;?dr|one[- ]liner|one line|quick(?:ly)?|concise|just (?:the|tell)|in a sentence|keep it short)\b/i;
const DETAILED = /\b(detail(?:ed|s)?|in[- ]depth|thorough(?:ly)?|step[- ]by[- ]step|comprehensive|exhaustive|full(?:y)? explain|elaborate|deep dive|walk me through)\b/i;
const WEB = /\b(search (?:the )?(?:web|internet|online|google)|google|look up|lookup|find (?:online|on the web)|on the (?:web|internet)|online|latest (?:version|release|news)|news|stack ?overflow|documentation|docs)\b/i;
const MYREPOS = /\b(my (?:github )?(?:repos|repositories|projects|github)|list (?:my )?repos)\b/i;
const EXTERNAL = /\b(latest|current|today'?s|news|search the web|look up|documentation for|docs for|release notes|changelog)\b/i;
const LONGFORM = /\b(?:write|generate|produce|give me)\b[^.\n]{0,40}\b(\d[\d,]*)\s*(words?|lines?|pages?|tokens?|chapters?)\b/i;

export function understand(text, { hasImages = false, projectFiles = 0, capabilities = {}, history = [] } = {}) {
  const t = text.trim(); const files = [...new Set((t.match(FILEISH) ?? []).map((f) => f.replace(/^\.\//, "")))];
  const urls = t.match(URL_RE) ?? []; const gh = [...t.matchAll(GH)].length > 0 || urls.some((u) => /github\.com/.test(u));
  const hasCodeFence = /```/.test(t);
  const signals = []; let intent = "chat";
  const codey = (has(CODE_VERB, t) && has(CODE_NOUN, t)) || files.length > 0 || hasCodeFence;
  if (has(PUBLISH, t) && (projectFiles > 0 || gh)) { intent = "publish"; signals.push("publish/deploy wording"); }
  else if (gh && !codey) { intent = "github"; signals.push("GitHub reference"); }
  else if (hasImages || (has(VISION, t) && hasImages)) { intent = codey || projectFiles ? "vision-coding" : "vision"; signals.push("image attached"); }
  else if (codey && has(ERRORISH, t)) { intent = "debug"; signals.push("error/failure wording + code"); }
  else if (codey) { intent = has(/\b(refactor|rename|restructure|clean ?up|reorgani[sz]e)\b/i, t) ? "refactor" : "coding"; signals.push("code verb + code noun/file mention"); }
  else if (has(/\b(explain|how does|how do|what (?:is|are|does)|why (?:is|does|do)|walk me through|summari[sz]e|describe)\b/i, t)) { intent = projectFiles && (files.length || has(/\b(this|the|our|my) (?:project|code|repo|app|codebase)\b/i, t)) ? "explain-code" : "explain"; signals.push("explanation wording"); }
  else if (has(EXTERNAL, t) || urls.length) { intent = "research"; signals.push("external info wording/url"); }

  const isCoding = ["coding", "debug", "refactor", "vision-coding", "explain-code", "publish"].includes(intent);
  const groups = new Set();
  if (isCoding || (projectFiles && files.length)) { groups.add("core"); groups.add("code"); }
  if (["coding", "debug", "refactor", "vision-coding"].includes(intent)) groups.add("versions");
  if (has(EXEC, t) || ["coding", "debug", "refactor", "vision-coding", "publish"].includes(intent)) groups.add("exec");
  const web = (urls.some((u) => !/github\.com/.test(u)) || has(WEB, t)) && capabilities.web; if (web) groups.add("web");
  if (gh || intent === "github" || intent === "publish" || has(MYREPOS, t)) { groups.add("github"); if (intent === "publish" || has(/\b(commit|push|branch|status|diff)\b/i, t)) groups.add("git"); }
  if (hasImages || intent.startsWith("vision")) groups.add("vision");
  if (has(/\b(remember|from now on|always use|forget)\b/i, t)) groups.add("memory");
  if (has(/\b(preview|render|open it|in the browser|run it)\b/i, t) || intent === "vision-coding") groups.add("browser");

  const verbosity = has(CONCISE, t) ? "concise" : has(DETAILED, t) ? "detailed" : isCoding ? "concise" : t.length < 60 ? "concise" : "normal";
  const steps = (t.match(/\b(?:and then|then|also|after that|next|finally|first|second)\b/gi) ?? []).length + (t.match(/\n\s*(?:[-*]|\d+[.)])\s/g) ?? []).length;
  const complexity = Math.min(1, t.length / 1200 + steps * 0.15 + files.length * 0.08 + (intent === "debug" ? 0.3 : 0) + (intent === "refactor" ? 0.25 : 0) + (isCoding ? 0.15 : 0));
  const lf = LONGFORM.exec(t); let expectedOutputTokens = isCoding ? 1500 : verbosity === "detailed" ? 1200 : verbosity === "concise" ? 300 : 600;
  if (lf) { const n = +lf[1].replace(/,/g, ""); const unit = lf[2].toLowerCase(); expectedOutputTokens = Math.round(n * (unit.startsWith("word") ? 1.4 : unit.startsWith("line") ? 12 : unit.startsWith("page") ? 700 : unit.startsWith("chapter") ? 4000 : 1)); signals.push(`long-form output ~${expectedOutputTokens} tokens`); }

  const plan = {
    intent, mode: isCoding ? "coding" : intent === "research" || intent === "explain" ? "research" : "chat",
    needs: { code: isCoding && projectFiles > 0, recall: REFERS_BACK.test(t) || history.length > 40, exec: groups.has("exec") && !!capabilities.exec, external: urls.length > 0 || EXTERNAL.test(t), image: hasImages, verify: isCoding, tools: groups.size > 0 },
    toolGroups: [...groups], verbosity, complexity: +complexity.toFixed(2), reasoning: complexity > 0.55 || intent === "debug" ? "on" : "off",
    mentionedFiles: files, urls, expectedOutputTokens, signals,
  };
  plan.explain = `${intent} · ${plan.mode} mode · tools: ${plan.toolGroups.join(",") || "none"} · ${verbosity} · reasoning ${plan.reasoning}${plan.needs.recall ? " · recall history" : ""}${plan.needs.verify ? " · verify" : ""}`;
  return plan;
}
