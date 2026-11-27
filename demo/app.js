const $ = (selector) => document.querySelector(selector);
const escape = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;"
})[char]);
const unique = (values) => [...new Set(values.filter(Boolean))];
const tiers = ["Definitive", "Strong", "Moderate", "Supportive", "Limited"];
const statusLabels = { pending: "待复核", confirmed: "采信", disputed: "存疑", excluded: "排除" };
const compoundMode = "MONOALLELIC_AND_BIALLELIC";
const omimAdAndAr = "AUTOSOMAL_DOMINANT_AND_RECESSIVE";
const omimInheritanceLabel = "来源声明 AD 和 AR";
const modifierLabel = "修饰因子";
const modes = {
  "HP:0000006": "AD", "HP:0000007": "AR", "HP:0001417": "XLR", "HP:0001423": "XLD",
  [compoundMode]: "单／双等位", [omimAdAndAr]: "AD 和 AR", UNKNOWN: "未声明"
};
const conflictLabels = { strength: "支持强度不同", conclusion: "关联结论有争议" };
const panelConfidence = new Map([["3", "绿 · 高"], ["2", "琥珀 · 中"], ["1", "红 · 低"]]);
const sourceFields = new Map([
  ["GenCC", {label: "关联证据分级", values: new Map([
    ["Definitive", "确证"], ["Strong", "证据强"], ["Moderate", "证据中等"],
    ["Supportive", "支持性证据"], ["Limited", "证据有限"], ["Disputed Evidence", "证据有争议"],
    ["Refuted Evidence", "证据已否定"], ["No Known Disease Relationship", "无已知疾病关联"]
  ])}],
  ["SysNDD", {label: "关联证据分级", values: new Map([
    ["Definitive", "确证"], ["Moderate", "证据中等"], ["Limited", "证据有限"],
    ["Refuted", "已否定"], ["not applicable", "不适用"]
  ])}],
  ["PanelApp UK", {label: "面板置信度", separator: " ", values: new Map([...panelConfidence, ["0", ""]])}],
  ["PanelApp Australia", {label: "面板置信度", separator: " ", values: panelConfidence}],
  ["OMIM", {label: "表型映射键", separator: " ", values: new Map([
    ["3", "已知该表型的分子基础"], ["4", "染色体缺失或重复相关综合征"]
  ])}],
  ["NCBI/ClinVar", {label: "资料出处", separator: " · ", values: new Map([
    "MONDO", "GeneReviews", "NCBI curation", "Orphanet", "Human Phenotype Ontology", "OMIM phenotypic series", "OMIM"
  ].map((value) => [value, ""]))}]
]);
const reviewPrefix = "morbidgenes:review:v1:";
const pendingReview = {status: "pending", note: "", evidence: []};
const samples = {
  "MONDO:0007750": {title: "Familial hypercholesterolemia type 1"},
  "MONDO:0007947": {aliases: ["MFS"]},
  "MONDO:0100135": {aliases: ["SMEI"]}
};

const search = $("#global-search");
const suggestions = $("#suggestions");
const drawer = $("#evidence-drawer");
const modal = $("#export-modal");
const state = {
  catalog: new Map(), geneIndex: new Map(), disease: null, genePage: null, scopePages: [],
  gene: null, drawerDisease: null, filter: "all", fold: true, scope: "exact", expandedGenes: new Set(),
  activeResult: -1, reviews: new Map(), toastTimer: null,
  drawerTrigger: null, modalTrigger: null, knowledgeBaseVersion: null, inputVersion: null, generation: null,
  requests: new Map(), adjustments: {}, selection: 0, snapshotRows: [], drawerSession: 0
};

const conceptType = (disease) => disease.entity_id.startsWith("HP:") ? "表型" : "疾病";
const displayName = (concept) => concept.zh || concept.title;
const knownMode = (relationship) => relationship.inheritance_id !== "UNKNOWN";
const modeText = (relationship) => modes[relationship.inheritance_id] || relationship.inheritance_label;
const sourceCount = (relations) => relations.reduce((total, relation) => total + relation.evidence_count, 0);
const strong = (gene) => gene.relationships.some(({rating}) => tiers.slice(0, 2).includes(rating));
const hasConflict = (gene, kind) => gene.relationships.some((relation) =>
  relation.ratingConflicts.some((conflict) => !kind || conflict.kind === kind));
const hasMixedModes = (gene) => gene.relationships.filter(knownMode).length > 1;
const hasMode = (gene, mode) => gene.relationships.some((relation) => relation.inheritance_id === mode);
const isModifier = (item) => item.source === "OMIM" && item.relationship_role === "modifier";
const getReview = (relation) => state.reviews.get(relation.entity_id) ?? pendingReview;
const isPending = (relation) => getReview(relation).status === "pending" || reviewNeedsConfirmation(getReview(relation));
const relationshipRows = (associations) => associations.flatMap(({gene}) => gene.relationships);

function sourceFieldValue(item) {
  const raw = item.source === "NCBI/ClinVar" ? item.record?.SourceName : item.source_rating;
  const value = String(raw ?? "");
  if (!value.trim()) return "";
  if (item.source === "OMIM") return value.replace(/^Phenotype mapping key (?=\d+$)/, "");
  return value;
}

function renderSourceField(item, value = sourceFieldValue(item)) {
  const definition = sourceFields.get(item.source);
  const label = definition?.label ?? "来源字段";
  if (!value) return escape(`${label}未提供`);
  let meaning = definition?.values.get(value) ?? "释义待补充";
  if (isModifier(item)) meaning = [meaning, modifierLabel].filter(Boolean).join(" · ");
  if (item.source === "PanelApp UK" && value === "0" && Array.isArray(item.record?.evidence) &&
    item.record.evidence.includes("Expert Review Removed")) {
    meaning = "专家复核标记为已移出";
  }
  const tone = label === "面板置信度" && panelConfidence.has(value) ? `confidence-${value}` : "";
  const text = definition?.separator ? `${label}${definition.separator}${value}` : value;
  return `${escape(text)}${meaning ? ` · <span${tone ? ` class="${tone}"` : ""}>${escape(meaning)}</span>` : ""}`;
}

function renderSourceFieldGuide(entries) {
  const groups = [
    [["GenCC", "SysNDD"], "Limited · 证据有限"],
    [["PanelApp UK", "PanelApp Australia"], '3 · <span class="confidence-3">绿（高）</span>'],
    [["OMIM"], "3 · 已知该表型的分子基础"],
    [["NCBI/ClinVar"], "MONDO、GeneReviews 等"]
  ];
  const observed = new Map([...sourceFields.keys()].map((source) => [source, new Map()]));
  for (const item of entries) {
    const values = observed.get(item.source);
    if (!values) continue;
    const value = sourceFieldValue(item);
    if (!values.has(value)) values.set(value, new Set());
    values.get(value).add(renderSourceField(item, value));
  }
  $("#source-field-guide").innerHTML = groups.map(([group, example]) => `<details class="source-guide-row">
    <summary class="source-guide-summary">
      <strong>${escape(group.join(" / "))}</strong><span>${sourceFields.get(group[0]).label}</span><span>${example}</span>
    </summary>
    <div class="source-guide-values">${group.map((source) => {
      const values = observed.get(source);
      const ordered = unique([...sourceFields.get(source).values.keys(), ...values.keys()]);
      const items = [...ordered, ""].flatMap((value) => [...(values.get(value) ?? [])]);
      return `<section>${group.length > 1 ? `<h3>${escape(source)}</h3>` : ""}
        ${items.length ? `<ul role="list">${items.map((item) => `<li>${item}</li>`).join("")}</ul>` : "<p>当前知识库暂无取值</p>"}
      </section>`;
    }).join("")}</div>
  </details>`).join("");
}

function evidenceQualifiers(item) {
  return {
    ...(isModifier(item) && {relationshipRole: item.relationship_role, relationshipRoleLabel: modifierLabel,
      sourceDiseaseLabel: item.source_disease_label}),
    ...(item.inheritance_ids && {inheritanceIds: item.inheritance_ids, sourceInheritance: item.source_inheritance})
  };
}

function evidenceReference(item) {
  return {
    source: item.source, recordId: item.source_record_id, assessor: item.assessor,
    rating: item.source_rating, rawPath: item.raw_path, rawLocator: item.raw_locator,
    sourceUrl: item.source_url, ...evidenceQualifiers(item)
  };
}

const evidenceKey = ({source, recordId, rawPath, rawLocator}) =>
  JSON.stringify([source, recordId, rawPath, Object.entries(rawLocator ?? {}).sort()]);

function previousReviewChanges(review) {
  if (review.knowledgeBaseVersion === state.knowledgeBaseVersion) return [];
  return (state.adjustments[review.relationshipKey] ?? []).filter((change) => !review.evidence.length ||
    review.evidence.some((reference) => evidenceKey(reference) === evidenceKey(change)));
}

const reviewNeedsConfirmation = (review) => previousReviewChanges(review).some(({newRelationshipKey}) => newRelationshipKey);

function readStoredReview(key, raw) {
  if (!raw) {
    state.reviews.delete(key);
    return;
  }
  try {
    const review = JSON.parse(raw);
    if (review?.relationshipKey === key && Object.hasOwn(statusLabels, review.status) && Array.isArray(review.evidence)) {
      state.reviews.set(key, review);
    }
  } catch (error) {
    console.warn("无法读取复核记录", key, error);
  }
}

function loadReviews() {
  try {
    for (const key of Object.keys(localStorage)) {
      if (key.startsWith(reviewPrefix)) readStoredReview(key.slice(reviewPrefix.length), localStorage.getItem(key));
    }
  } catch (error) {
    console.warn("无法读取浏览器中的复核记录", error);
  }
}

function notify(message) {
  const toast = $("#toast");
  toast.textContent = message;
  toast.classList.add("visible");
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.remove("visible"), 2500);
}

const normalizedText = (value) => String(value ?? "").normalize("NFKC").toLowerCase();
const foldText = (value) => normalizedText(value).replace(/[^\p{L}\p{N}]/gu, "");
const searchTerms = (values) => unique(values.map(foldText));
function distanceOne(a, b) {
  if (Math.abs(a.length - b.length) > 1) return false;
  let index = 0;
  while (index < Math.min(a.length, b.length) && a[index] === b[index]) index++;
  return a.slice(index + 1) === b.slice(index + 1) ||
    a.slice(index) === b.slice(index + 1) || a.slice(index + 1) === b.slice(index) ||
    (a[index] === b[index + 1] && a[index + 1] === b[index] && a.slice(index + 2) === b.slice(index + 2));
}

function searchScore(input, term, words) {
  if (input === term) return 4;
  if (term.startsWith(input)) return 3;
  if (term.includes(input) || (words.length > 1 && words.every((word) => term.includes(word)))) return 2;
  if (input.length >= 4 && !/\d/.test(input) && distanceOne(input, term)) return 1;
  return 0;
}

function renderSuggestions() {
  const query = search.value.trim();
  const exact = normalizedText(query);
  const input = foldText(query);
  const words = exact.match(/[\p{L}\p{N}]+/gu) ?? [];
  state.activeResult = -1;
  if (!input) return dismissSuggestions();
  const scoreTerms = (terms) => Math.max(0, ...terms.map((term) => searchScore(input, term, words)));

  const concepts = [...state.catalog.values()].map((disease) => ({
    disease, score: scoreTerms(disease.terms)
  })).filter(({score}) => score);
  const genes = [...state.geneIndex.values()].map(({gene, exactKeys, keys, terms}) => {
    if (exactKeys.includes(exact)) return {gene, score: 6};
    return {gene, score: keys.includes(input) ? 5 : scoreTerms(terms)};
  }).filter(({score}) => score);

  function group(label, results) {
    if (!results.length) return "";
    const buttons = results.sort((a, b) => b.score - a.score).slice(0, 8).map(({ disease, gene, score }) => {
      const fields = gene ? `data-gene="${escape(gene.hgnc_id)}"` : `data-disease="${escape(disease.entity_id)}"`;
      return `<button class="suggestion-item" ${fields} data-score="${score}">
        <span class="suggestion-name"><strong class="${gene ? "mono" : ""}">${escape(gene?.symbol ?? displayName(disease))}</strong>
          <span>${escape(gene?.name ?? (disease.zh ? disease.title : ""))}</span></span>
        <span class="suggestion-code">${gene ? `<code>${escape(gene.hgnc_id)}</code> · ${gene.association_count} 个关联概念` :
          `<code>${escape(disease.entity_id)}</code>`}</span>
      </button>`;
    }).join("");
    return `<div class="suggestion-group"><div class="suggestion-group-label">${label}</div>${buttons}</div>`;
  }

  suggestions.innerHTML = group("疾病 / 表型", concepts) + group("基因", genes) ||
    '<div class="suggestion-empty">未找到匹配项</div>';
  suggestions.hidden = false;
  search.setAttribute("aria-expanded", "true");
}

function dismissSuggestions() {
  suggestions.hidden = true;
  search.setAttribute("aria-expanded", "false");
}

function setSearchPlacement(inToolbar) {
  const toolbar = $("#toolbar-search");
  const host = inToolbar ? toolbar : $("#home-search");
  const searchWrap = $("#search-wrap");
  if (searchWrap.parentElement !== host) host.append(searchWrap);
  toolbar.hidden = !inToolbar;
  $("#home").hidden = inToolbar;
}

async function showWorkspace(navigate) {
  const selection = ++state.selection;
  const {disease, genePage} = state;
  const list = $("#review-list");
  const status = $("#detail-status");
  const retry = $("#retry-details");
  $("#clear-search").hidden = false;
  dismissSuggestions();
  setSearchPlacement(true);
  $("#workspace").hidden = false;
  state.filter = "all";
  state.expandedGenes.clear();
  state.scope = "exact";
  state.scopePages = [];
  list.hidden = true;
  retry.hidden = status.hidden = true;
  renderOverview(disease, genePage);
  if (navigate) {
    $("#entity-title").focus({preventScroll: true});
    window.scrollTo(0, 0);
  }
  status.hidden = false;
  $("#detail-message").textContent = "正在加载关联…";
  try {
    const [detail] = await Promise.all([
      disease ? loadDisease(disease.entity_id) : loadGene(genePage.gene.hgnc_id),
      loadReviewAdjustments()
    ]);
    if (selection !== state.selection) return;
    if (disease) state.disease = detail;
    else state.genePage = detail;
  } catch (error) {
    if (selection !== state.selection) return;
    console.error(error);
    $("#detail-message").textContent = "关联加载失败。";
    retry.hidden = false;
    return;
  }
  const wasFocused = document.activeElement === $("#entity-title");
  renderOverview(state.disease, state.genePage);
  if (wasFocused) $("#entity-title").focus({preventScroll: true});
  if (state.genePage && !state.genePage.associations.length) {
    $("#detail-message").textContent = "本版知识库暂无可按标准标识展示的关联";
    return;
  }
  status.hidden = true;
  list.hidden = false;
  renderWorkspace();
}

function selectDisease(id, navigate = true) {
  const disease = state.catalog.get(id);
  if (!disease) return;
  state.disease = disease;
  state.genePage = null;
  state.scope = "exact";
  search.value = displayName(disease);
  if (navigate) updateRoute("disease", id);
  showWorkspace(navigate);
}

function selectGene(id, navigate = true) {
  const entry = state.geneIndex.get(id);
  if (!entry) return;
  state.genePage = entry;
  state.disease = null;
  search.value = entry.gene.symbol;
  if (navigate) updateRoute("gene", id);
  showWorkspace(navigate);
}

function updateRoute(type, id) {
  const hash = new URLSearchParams({[type]: id}).toString();
  if (location.hash.slice(1) !== hash) history.pushState(null, "", "#" + hash);
}

function readRoute() {
  if (modal.open) modal.close();
  if (drawer.open) drawer.close();
  const params = new URLSearchParams(location.hash.slice(1));
  if (state.geneIndex.has(params.get("gene"))) {
    selectGene(params.get("gene"), false);
  } else if (state.catalog.has(params.get("disease"))) {
    selectDisease(params.get("disease"), false);
  } else {
    ++state.selection;
    state.disease = state.genePage = null;
    search.value = "";
    dismissSuggestions();
    $("#clear-search").hidden = true;
    setSearchPlacement(false);
    $("#workspace").hidden = true;
  }
}

function renderHierarchy(disease) {
  const sections = [
    ["上位表型", disease.features],
    [conceptType(disease) === "表型" ? "上位表型分类" : "上位疾病", disease.parents],
    ["下属亚型", disease.children],
    ["关联疾病分支", disease.disease_branch ? [disease.disease_branch] : []]
  ];
  const links = sections.filter(([, items]) => items.length).map(([label, items]) => `
    <div class="ontology-line"><span>${label}</span><div class="ontology-links">${items.map((item) => {
      const entry = state.catalog.get(item.id);
      const title = entry?.zh || item.title;
      const english = entry?.title || item.english_title;
      const text = `${escape(title)} ${english && english !== title ? `<span lang="en">${escape(english)}</span> ` : ""}
        <code>${escape(item.id)}</code>`;
      return state.catalog.has(item.id) ? `<button type="button" class="ontology-link" data-disease="${escape(item.id)}">${text}</button>` :
        `<span class="ontology-link ontology-static">${text}</span>`;
    }).join("")}</div></div>`).join("");
  const features = renderClinicalFeatures(disease.clinical_features ?? []);
  if (!links && !features) return "";
  return `<div class="ontology-panel">${features}${links}</div>`;
}

function renderClinicalFeatures(features) {
  if (!features.length) return "";
  const searchId = "feature-search";
  return `<details class="feature-panel">
    <summary><strong>临床特征 ${features.length} 项</strong>
      <span class="feature-preview">${features.length > 4 ? "部分条目 · " : ""}${features.slice(0, 4).map(({title}) => escape(title)).join("、")}</span>
    </summary>
    <label for="${searchId}">查找临床特征</label>
    <input type="search" id="${searchId}" autocomplete="off" placeholder="中文、英文或 HPO 编号" />
    <p class="feature-count" id="feature-count" role="status">显示 ${features.length} 项</p>
    <ul class="clinical-features" role="list">${features.map((feature) => {
      const {id, title, english_title: english, aliases = [], hpo_annotations = [], mondo_predicates = []} = feature;
      return `<li data-feature-terms="${escape(searchTerms([id, title, english, ...aliases]).join(" "))}">
        <details><summary>${escape(title)}</summary>
          <div class="feature-source"><a href="https://hpo.jax.org/browse/term/${escape(id)}" target="_blank" rel="noopener noreferrer"><code>${escape(id)}</code></a>
            <span lang="en">${escape(english)}</span></div>
          ${hpo_annotations.map(({disease_id: diseaseId, references}) => `<div class="feature-source">
            <span>HPO 疾病注释</span><code>${escape(diseaseId)}</code>${references.map(annotationLink).join(" ")}</div>`).join("")}
          ${mondo_predicates.map((predicate) => `<div class="feature-source"><span>MONDO 表型注释</span>
            <span>${predicate === "disease_has_major_feature" ? "主要表型" : "相关表型"}</span><code>${escape(predicate)}</code></div>`).join("")}
        </details></li>`;
    }).join("")}</ul></details>`;
}

function annotationLink(reference) {
  const pubmed = /^PMID:(\d+)$/.exec(reference);
  const orphanet = /^ORPHA:(\d+)$/.exec(reference);
  const url = pubmed ? `https://pubmed.ncbi.nlm.nih.gov/${pubmed[1]}/` :
    orphanet ? `https://www.orpha.net/en/disease/detail/${orphanet[1]}` : "";
  return url ? `<a href="${url}" target="_blank" rel="noopener noreferrer"><code>${escape(reference)}</code></a>` :
    `<code>${escape(reference)}</code>`;
}

function renderReplacement(disease) {
  if (!disease?.obsolete || !disease.replaced_by?.length) return "";
  const label = disease.merged ? "此编号已合并至" : "此编号已替换为";
  return disease.replaced_by.map((id) => {
    const local = state.catalog.has(id);
    const url = local ? "#" + new URLSearchParams({disease: id}) :
      "https://purl.obolibrary.org/obo/" + encodeURIComponent(id.replace(":", "_"));
    return `<p class="concept-replacement">${label} <code>${escape(id)}</code> · <a href="${escape(url)}"
      ${local ? `data-disease="${escape(id)}"` : 'target="_blank" rel="noopener noreferrer"'}>查看现行条目</a></p>`;
  }).join("");
}

function renderScope(disease) {
  const scope = $("#association-scope");
  scope.hidden = !disease;
  if (!disease) return;
  if (!disease.scope_ids.length) {
    scope.innerHTML = '<span class="scope-label">关联范围</span><span class="scope-current">仅看当前</span>';
    return;
  }
  const options = [
    ["exact", "仅看当前"], ["merged", disease.disease_branch ? "合并关联疾病及亚型" : "合并下属亚型"]
  ];
  scope.innerHTML = `<span class="scope-label">关联范围</span><div class="scope-switch" role="group" aria-label="关联范围">
    ${options.map(([id, label]) => `<button type="button" data-scope="${id}" aria-pressed="${state.scope === id}">${label}</button>`).join("")}
  </div>`;
}

function progressBar(reviewed, total) {
  return `<div class="overview-progress">
    <div class="progress-header"><span>已复核关系键</span><strong>${reviewed} / ${total}</strong></div>
    <progress class="progress-track" value="${reviewed}" max="${total || 1}" aria-label="复核进度"></progress>
  </div>`;
}

function renderDefinition(disease) {
  const definition = disease?.overview;
  if (!definition) return "";
  const label = conceptType(disease) === "表型" ? "表型定义" : "疾病概述";
  const kindLabels = {wiki: "知识库中文概述", translation: "中文摘译", machine_translation: "机器翻译"};
  const version = definition.version?.match(/\b\d{4}-\d{2}-\d{2}\b/)?.[0] ?? definition.version;
  const source = [kindLabels[definition.kind], definition.source, definition.entry_id,
    [definition.version_label, version].filter(Boolean).join(" ")].filter(Boolean).join(" · ");
  const link = (url, text) => `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  return `<section class="concept-definition" aria-labelledby="concept-definition-title">
    <h2 id="concept-definition-title">${label}</h2>
    <p class="definition-text" lang="zh-CN">${escape(definition.text)}</p>
    ${definition.url ? `<div class="definition-attribution">
      <span>${escape(source)}</span>
      ${link(definition.url, "查看来源条目")}
      ${definition.wiki_reference ? link(definition.wiki_reference, "查看知识库引用") : ""}
      ${definition.translation_url ? link(definition.translation_url, "查看 CHPO 摘译来源") : ""}
    </div>` : ""}
  </section>`;
}

function renderOverview(disease, genePage) {
  const gene = genePage?.gene;
  const name = gene ? gene.symbol : displayName(disease);
  const englishName = gene ? gene.name : disease.zh && disease.title;
  const codes = disease?.search_codes ?? [];
  const terms = gene ? [gene.hgnc_id, gene.location, gene.entrez_id && `NCBI Gene ${gene.entrez_id}`,
    gene.ensembl_gene_id].filter(Boolean) : [
    disease.entity_id,
    ...codes.filter((id) => /^OMIM:/i.test(id)),
    ...codes.filter((id) => /^Orphanet:/i.test(id))
  ];
  const heading = gene ? "基因反查" : disease.obsolete ? "历史编号" : "";
  const hierarchy = disease?.parents ? renderHierarchy(disease) : "";
  $("#disease-overview").innerHTML = `${heading ? `<p class="overview-kicker">${heading}</p>` : ""}
    <h1 class="overview-title ${gene ? "mono" : ""}" id="entity-title" tabindex="-1">${escape(name)}</h1>
    ${englishName ? `<p class="overview-aliases" lang="en">${escape(englishName)}</p>` : ""}
    <p class="overview-codes" aria-label="标准标识">
      ${terms.map((id) => `<code>${escape(id)}</code>`).join(" · ")}</p>
    ${renderReplacement(disease)}
    ${renderDefinition(disease)}
    ${hierarchy}`;
}


function associationRows(concepts) {
  return concepts.flatMap((disease) => disease.genes.map((gene) => ({disease, gene})));
}

function activeAssociations() {
  if (state.genePage) return state.genePage.associations ?? [];
  if (!state.disease?.genes) return [];
  return associationRows([state.disease, ...(state.scope === "merged" ? state.scopePages : [])]);
}

function conflictSummary({source, counts}) {
  return `${source} · ${counts.map(({value, count}) => {
    const label = {"Disputed Evidence": "有争议", "Refuted Evidence": "已否定"}[value] ??
      sourceFields.get(source).values.get(value) ?? value;
    return `${label} ${count}`;
  }).join("／")}`;
}

function renderAssociation({disease, gene}, {showConcept, reverse, expandedDetails}) {
  const relations = gene.relationships;
  const conflicts = relations.flatMap((relation) => relation.ratingConflicts.map((conflict) => ({...conflict, relation})));
  const conclusion = conflicts.find(({kind}) => kind === "conclusion");
  const strength = conflicts.find(({kind}) => kind === "strength");
  const modifierEvidence = relations.find(({example}) => isModifier(example))?.example;
  const best = tiers.find((tier) => relations.some(({rating}) => rating === tier));
  const sourceExample = modifierEvidence || (best && relations.find(({rating}) => rating === best)?.example) ||
    relations.find(({example}) => sourceFieldValue(example))?.example || relations[0].example;
  const id = `association-${gene.hgnc_id}-${disease.entity_id}`;
  const expanded = expandedDetails.has(id);
  const name = reverse ? displayName(disease) : gene.symbol;
  const englishName = reverse ? disease.zh && disease.title : gene.name;
  const identifiers = reverse ? disease.entity_id : [gene.hgnc_id, gene.location].filter(Boolean).join(" · ");
  const openLabel = `查看 ${gene.symbol} 在 ${displayName(disease)} 的证据`;
  return `<div class="gene-row association-grid${expanded ? " details-open" : ""}" role="row" id="${escape(id)}"
    data-hgnc="${escape(gene.hgnc_id)}" data-concept="${escape(disease.entity_id)}">
    <div class="association-identity" role="rowheader">
      <div class="association-name-line">
        <button type="button" class="gene-main gene-symbol ${reverse ? "" : "mono"}" data-open aria-label="${escape(openLabel)}"
          ${reverse && !disease.zh ? 'lang="en"' : ""}>${escape(name)}</button>
        ${!reverse && state.geneIndex.has(gene.hgnc_id) ? `<button type="button" class="text-button association-extra" data-gene="${escape(gene.hgnc_id)}" aria-label="反查 ${escape(gene.symbol)}">反查 <span aria-hidden="true">↗</span></button>` : ""}
      </div>
      ${englishName ? `<span class="gene-name" lang="en">${escape(englishName)}</span>` : ""}
      <div class="association-meta association-extra" id="${escape(id)}-meta">
        <code class="gene-subline">${escape(identifiers)}</code>
        ${showConcept ? `<button type="button" class="text-button" data-disease="${escape(disease.entity_id)}">${escape(reverse ? "打开疾病 / 表型" : displayName(disease))}</button>` : ""}
      </div>
    </div>
    <div class="inheritance-cell" role="cell">
      <span class="cell-label" aria-hidden="true">遗传方式</span>
      <div class="inheritance-modes">${unique(relations.map(modeText)).map((mode) =>
        `<span>${escape(mode)}</span>`).join("")}</div>
      ${hasMode(gene, omimAdAndAr) ? `<p class="cell-note source-inheritance">OMIM ${omimInheritanceLabel}</p>` : ""}
      ${hasMode(gene, compoundMode) ? '<p class="cell-note">来源包含单等位及双等位模式</p>' : ""}
    </div>
    <div class="evidence-cell" role="cell">
      <button type="button" class="text-button row-details-toggle" data-row-details
        aria-expanded="${expanded}" aria-controls="${escape(id)}-evidence ${escape(id)}-meta">${expanded ? "收起证据与标识" : "展开证据与标识"}</button>
      <div class="association-evidence" id="${escape(id)}-evidence">
        <button type="button" class="text-button evidence-count association-extra" data-open>${sourceCount(relations)} 条来源记录</button>
        ${conclusion ? `<p class="source-field-summary conclusion-summary">${escape(conflictSummary(conclusion))}</p>` :
          sourceExample ? `<p class="source-field-summary${modifierEvidence ? "" : " association-extra"}">${escape(sourceExample.source)} · ${renderSourceField(sourceExample)}</p>` : ""}
        <p class="cell-note association-extra">${escape(unique(relations.flatMap(({sources}) => sources)).join(" / "))}</p>
        ${[conclusion, strength].filter(Boolean).map(({kind, relation}) => `<div class="rating-conflict ${kind}">
          <span>${conflictLabels[kind]}</span>
          <button type="button" class="text-button conflict-link" data-relation-open="${escape(relation.entity_id)}"
            aria-label="${conflictLabels[kind]} · 比较 ${escape(modeText(relation))} 原始评级">比较原始评级</button></div>`).join("")}
        ${reverse ? `<details class="association-keys association-extra"><summary>关系键</summary><ul>${relations.map((item) =>
          `<li><code>${escape(item.entity_id)}</code></li>`).join("")}</ul></details>` : ""}
      </div>
    </div>
    <div class="review-cell" role="cell"><span class="cell-label" aria-hidden="true">复核状态</span><div class="row-review-modes">${relations.map((relation) => {
      const review = getReview(relation);
      const mode = modeText(relation);
      const label = reviewNeedsConfirmation(review) ? "待重新确认" : statusLabels[review.status];
      return `<button type="button" class="mode-review ${review.status}" data-relation-open="${escape(relation.entity_id)}"
        aria-label="复核 ${escape(gene.symbol)} ${escape(mode)} · ${label}"><span class="review-mode">${escape(mode)}</span>
        <span class="review-status">${label}${review.note ? " ✎" : ""}</span></button>`;
    }).join("")}</div></div>
  </div>`;
}

function groupAssociations(associations) {
  const groups = new Map();
  for (const entry of associations) {
    const key = entry.gene.hgnc_id;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return [...groups.values()].sort(([left], [right]) =>
    Number(strong(right.gene)) - Number(strong(left.gene)) || left.gene.symbol.localeCompare(right.gene.symbol));
}

function renderWorkspace() {
  const {disease, genePage} = state;
  if (!disease?.genes && !genePage?.associations) return;
  const merged = !genePage && state.scope === "merged";
  const associations = activeAssociations();
  const relations = relationshipRows(associations);
  const unit = genePage ? "个疾病 / 表型" : "个关联基因";
  const count = (items) => merged ? new Set(items.map(({gene}) => gene.hgnc_id)).size : items.length;
  renderScope(disease);
  $("#review-progress").innerHTML = progressBar(relations.filter((relation) => !isPending(relation)).length, relations.length);

  const all = () => true;
  const filters = [
    ["all", "全部", all], ["strong", "含确证或强证据", ({gene}) => strong(gene)],
    ["pending", "待复核", ({gene}) => gene.relationships.some(isPending)],
    ["conclusion", conflictLabels.conclusion, ({gene}) => hasConflict(gene, "conclusion")],
    ["strength", conflictLabels.strength, ({gene}) => hasConflict(gene, "strength")],
    ["priority", "优先复核", ({gene}) => hasConflict(gene) || hasMixedModes(gene) ||
      hasMode(gene, compoundMode) || hasMode(gene, omimAdAndAr)]
  ];
  $("#association-column-title").textContent = genePage ? "疾病 / 表型" : "基因";
  $("#filter-pills").innerHTML = filters.map(([key, label, test]) =>
    `<button class="filter-pill" data-filter="${key}" aria-pressed="${state.filter === key}">${label} <span>${count(associations.filter(test))}</span></button>`
  ).join("");
  const shown = associations.filter(filters.find(([key]) => key === state.filter)[2]);
  $("#list-counts").innerHTML = `<span><strong>${count(associations)}</strong> ${unit}</span>
    <span><strong>${relations.length}</strong> 个关系键</span>
    ${merged ? `<span class="list-context">${state.scopePages.length + 1} 个概念 · ${associations.length} 条原始关联</span>` : ""}
    ${shown.length < associations.length ? `<span class="list-context">筛选后显示 ${count(shown)} ${unit}${merged ? ` · ${shown.length} 条原始关联` : ""}</span>` : ""}`;
  const expandedDetails = new Set([...$("#gene-list").querySelectorAll(".details-open")].map((row) => row.id));
  const rendered = merged ? groupAssociations(shown).map((group) => {
    const options = {showConcept: true, expandedDetails};
    if (group.length === 1) return renderAssociation(group[0], options);
    const {symbol, hgnc_id, name} = group[0].gene;
    const expanded = state.expandedGenes.has(hgnc_id);
    const target = `aggregate-${hgnc_id}`;
    return `<div class="aggregate-heading" role="row"><div role="cell" aria-colspan="4">
      <button type="button" data-aggregate="${escape(hgnc_id)}" aria-expanded="${expanded}" aria-controls="${escape(target)}">
        <strong class="mono">${escape(symbol)}</strong><span>${escape(name)}</span><span>${group.length} 个来源概念</span>
      </button></div></div>
      <div class="aggregate-body" role="presentation" id="${escape(target)}" ${expanded ? "" : "hidden"}>
        ${group.map((entry) => renderAssociation(entry, options)).join("")}</div>`;
  }) : shown.map((entry) => renderAssociation(entry, {showConcept: Boolean(genePage), reverse: Boolean(genePage), expandedDetails}));
  $("#gene-list").innerHTML = rendered.join("") ||
    '<div role="row"><div role="cell" aria-colspan="4" class="no-results-card">当前范围暂无关联记录</div></div>';
}


function pmids(record) {
  const items = [record.submitted_as_pmids, ...[record.publications].flat()].filter(Boolean);
  return unique(items.flatMap((item) => {
    const value = String(item).trim();
    if (/^[0-9\s,;|]+$/.test(value)) return value.match(/\d{4,9}/g) ?? [];
    return [...value.matchAll(/(?:pubmed\.ncbi\.nlm\.nih\.gov\/|PMID\s*:?\s*)(\d{4,9})/gi)]
      .map((match) => match[1]);
  }));
}

function renderEvidence(item, recordKey, itemIndex, formId, mode, checked) {
  const raw = item.record;
  const pubmed = pmids(raw);
  const sourceLabel = raw.disease_original_title || item.source_disease_label;
  const sourceId = raw.disease_original_curie || item.source_disease_id;
  const assessor = item.assessor && item.assessor !== item.source ? `<span>${escape(item.assessor)}</span>` : "";
  const recordId = escape(item.source_record_id);
  const combinedOmim = item.inheritance_id === omimAdAndAr;
  const sourceMode = combinedOmim ? omimInheritanceLabel : mode;
  const recordLabel = combinedOmim ? `${recordId} · ${escape(sourceLabel)}` : recordId;
  const sourceUrl = /^https?:\/\//i.test(item.source_url ?? "") ? item.source_url : null;
  return `<tr class="appendix-record">
    <th scope="row"><span class="record-source"><strong>${escape(item.source)}</strong>${assessor}</span>
      ${sourceMode ? `<span class="source-mode">${escape(sourceMode)}</span>` : ""}
      ${combinedOmim ? `<span class="source-mode" lang="en">${escape(item.source_inheritance)}</span>` : ""}</th>
    <td class="record-source-field">${renderSourceField(item)}</td>
    <td><button type="button" class="record-link" data-record-toggle aria-expanded="false" aria-controls="source-record-${recordKey}"
      aria-label="来源详情 ${recordLabel}"><code>${recordId}</code></button>
      ${combinedOmim ? `<span class="source-mode">${escape(sourceLabel)}</span>` : ""}</td>
    <td class="reference-check"><input type="checkbox" form="${formId}" name="reference" value="${itemIndex}"
      aria-label="引用 ${escape(item.source)} ${recordLabel}" ${checked ? "checked" : ""}></td>
  </tr>
  <tr class="record-expanded" id="source-record-${recordKey}" hidden><td colspan="4">
    <div class="record-body">
      <div class="record-meta">${escape(sourceLabel)} · <code>${escape(sourceId)}</code> · ${escape(item.source_inheritance || "遗传方式未声明")}</div>
      ${raw.submitted_as_notes ? `<p class="record-notes">${escape(raw.submitted_as_notes)}</p>` : ""}
      ${pubmed.length ? `<div class="record-pmids"><code>PMID</code> ${pubmed.map((id) =>
        `<a class="mono" href="https://pubmed.ncbi.nlm.nih.gov/${id}/" target="_blank" rel="noopener noreferrer">${id}</a>`).join(" · ")}</div>` : ""}
      ${sourceUrl ? `<a href="${escape(sourceUrl)}" target="_blank" rel="noopener noreferrer">查看来源条目</a>` : ""}
      <details class="raw-record"><summary>原始来源字段</summary><pre>${escape(JSON.stringify(raw, null, 2))}</pre></details>
    </div>
  </td></tr>`;
}

const formatReviewTime = (time) => new Date(time).toLocaleString("zh-CN");
const reviewMetadata = (review) => review.reviewedAt
  ? `<time datetime="${escape(review.reviewedAt)}">${escape(formatReviewTime(review.reviewedAt))}</time>
    <code>${escape(review.knowledgeBaseVersion)}</code>` : "";

function previousDecision(review) {
  return `<details class="review-note"><summary>原决定与引用 · ${statusLabels[review.status]}</summary>
    <div class="review-version"><code>${escape(review.relationshipKey)}</code> ${reviewMetadata(review)}</div>
    ${review.note ? `<p>${escape(review.note)}</p>` : ""}
    ${review.evidence.map((item) => `<div class="review-version">${escape(item.source)} · <code>${escape(item.recordId)}</code>
      <code>${escape(item.rawPath)} · ${escape(JSON.stringify(item.rawLocator))}</code></div>`).join("")}
  </details>`;
}

function renderRelationshipReview(relation, formId, review, outdated) {
  const mode = modeText(relation);
  const rekeyed = reviewNeedsConfirmation(review);
  const legacy = (relation.previous_keys ?? []).flatMap((key) => {
    const previous = state.reviews.get(key);
    if (!previous) return [];
    return [previous, ...(previous.history ?? []).map((entry) => ({...entry, relationshipKey: key}))].filter((entry) =>
      previousReviewChanges(entry).some(({newRelationshipKey}) => newRelationshipKey === relation.entity_id));
  });
  return `<form class="relation-review" id="${formId}" data-relationship="${escape(relation.entity_id)}"
    aria-label="${escape(mode)} 关系复核" data-reviewed-at="${escape(review.reviewedAt)}">
    <div class="relation-review-heading"><strong class="mono">${escape(mode)}</strong>
      <span data-review-status class="mode-state ${review.status}">${statusLabels[review.status]}</span></div>
    <div class="relationship-key"><code>${escape(relation.entity_id)}</code>
      <button type="button" class="text-button copy-key" data-copy-key aria-label="复制 ${escape(mode)} 关系键">复制</button></div>
    <div class="relation-review-actions">
      <label class="relation-field"><span>复核结论</span>
        <select name="status">${Object.entries(statusLabels).map(([status, label]) =>
          `<option value="${status}" ${review.status === status ? "selected" : ""}>${label}</option>`).join("")}</select></label>
      <button class="save-note" type="submit">保存复核</button>
    </div>
    <details class="review-note" ${review.note ? "open" : ""}><summary>批注</summary>
      <textarea name="note" rows="2" aria-label="${escape(mode)} 批注" placeholder="记录采信理由或待核事项">${escape(review.note)}</textarea>
    </details>
    <div class="review-version" data-previous-version>${rekeyed
      ? `部分来源记录已移至 AD 和 AR 关系。请重新确认这条决定。${previousDecision(review)}`
      : outdated ? `知识库已更新，请核对原决定。${previousDecision(review)}` : ""}</div>
    ${legacy.length ? `<div class="review-version">以下决定按旧关系键保存，请核对本关系的来源记录后重新确认。${legacy.map(previousDecision).join("")}</div>` : ""}
    <div class="review-version" data-review-metadata>${reviewMetadata(review)}</div>
    <div class="form-feedback" data-review-feedback role="status"></div>
  </form>`;
}

function renderEvidenceGroup(group, index) {
  const label = group.map(modeText).join(" / ");
  const id = `appendix-group-${index}`;
  const weak = group.every((relation) => !knownMode(relation) && !relation.rating && !relation.ratingConflicts.length);
  return `<section class="appendix-group" data-group-index="${index}" ${weak ? "data-noise" : ""} aria-labelledby="${id}-toggle">
    <div class="appendix-group-grid appendix-group-heading">
      <button type="button" class="appendix-toggle" data-group-toggle id="${id}-toggle" aria-controls="${id}" aria-expanded="false">
        <span class="mono">${escape(label)}</span><span class="mode-description">${group.length === 1 ? escape(group[0].inheritance_label) :
          group.map((relation) => `${escape(modeText(relation))} ${relation.evidence_count} 条`).join(" · ")}</span>
      </button>
      <span class="appendix-count">${sourceCount(group)} 条</span>
      <button type="button" class="text-button group-references" data-select-references aria-controls="${id}" aria-label="${escape(label)} 选择引用">选择引用</button>
    </div>
    <div class="appendix-group-body" id="${id}" hidden></div>
  </section>`;
}

function renderGroupBody(group, index) {
  const label = group.map(modeText).join(" / ");
  const id = `appendix-group-${index}`;
  const relationViews = group.map((relation, relationIndex) => {
    const formId = `${id}-review-${relationIndex}`;
    const review = getReview(relation);
    const outdated = reviewNeedsConfirmation(review) || (review.reviewedAt &&
      ![state.knowledgeBaseVersion, state.inputVersion].includes(review.knowledgeBaseVersion));
    const selected = new Set(outdated ? [] : review.evidence.map(evidenceKey));
    return {relation, formId, review, outdated, selected};
  });
  const conflicts = unique(group.flatMap((relation) =>
    relation.ratingConflicts.map(({source, kind}) => `${source} · ${conflictLabels[kind]}`)));
  return `${conflicts.map((conflict) => `<p class="appendix-conflict">${escape(conflict)}</p>`).join("")}
      <table class="appendix-records" aria-label="${escape(label)} 来源记录">
        <thead><tr><th scope="col">来源 / 提交方</th><th scope="col">来源字段</th><th scope="col">记录编号</th><th scope="col">引用</th></tr></thead>
        <tbody>${relationViews.map(({relation, formId, selected}, relationIndex) => relation.evidence.map((item, itemIndex) =>
          renderEvidence(item, `${index}-${relationIndex}-${itemIndex}`, itemIndex, formId,
            group.length > 1 ? modeText(relation) : "", selected.has(evidenceKey(evidenceReference(item))))).join("")).join("")}</tbody>
      </table>
      <section class="appendix-review" aria-label="人工复核">
        <h4>人工复核</h4>
        <div class="appendix-review-grid">${relationViews.map(({relation, formId, review, outdated}) =>
          renderRelationshipReview(relation, formId, review, outdated)).join("")}</div>
      </section>`;
}

function renderDrawerSummary() {
  const {gene} = state;
  const reviewed = gene.relationships.filter((relation) => !isPending(relation)).length;
  $("#drawer-status-row").textContent = `人工复核进度 ${reviewed} / ${gene.relationships.length} 个关系键`;
}

function renderDrawer() {
  const {gene, drawerDisease: disease} = state;
  $("#drawer-gene-title").innerHTML = `<span class="mono">${escape(gene.symbol)}</span><span class="drawer-title-slash"> / </span><span>${escape(displayName(disease))}</span>`;
  const identifiers = [gene.hgnc_id, disease.entity_id, gene.location].filter(Boolean)
    .map((id) => `<code>${escape(id)}</code>`).join(" · ");
  $("#drawer-identifiers").innerHTML = `${disease.zh ? `<span lang="en">${escape(disease.title)}</span> · ` : ""}${identifiers}`;
  renderDrawerSummary();

  const recessive = gene.relationships.find((relation) => relation.inheritance_id === "HP:0000007");
  const compound = gene.relationships.find((relation) => relation.inheritance_id === compoundMode);
  const groups = gene.relationships.filter((relation) => !(recessive && relation === compound))
    .map((relation) => relation === recessive && compound ? [recessive, compound] : [relation]);
  state.drawerGroups = groups;
  $("#relationship-groups").innerHTML = groups.map(renderEvidenceGroup).join("");
  $("#drawer-evidence-count").textContent = `${sourceCount(gene.relationships)} 条来源记录`;
  $("#drawer-feedback").textContent = "";
  drawer.querySelectorAll(".appendix-group").forEach(updateReferenceCount);
  renderReviewHistory();
}

async function setEvidenceGroupOpen(group, open) {
  const body = group.querySelector(".appendix-group-body");
  group.querySelector("[data-group-toggle]").setAttribute("aria-expanded", open);
  body.hidden = !open;
  if (!open || body.dataset.loaded) return;
  body.innerHTML = '<p role="status">正在加载来源记录…</p>';
  const index = Number(group.dataset.groupIndex);
  const relations = state.drawerGroups[index];
  const session = state.drawerSession;
  try {
    const evidence = await Promise.all(relations.map((relation) => loadPart("evidence", relation.entity_id)));
    if (session !== state.drawerSession || !drawer.open || !group.isConnected || body.dataset.loaded) return;
    relations.forEach((relation, i) => { relation.evidence = evidence[i]; });
    body.innerHTML = renderGroupBody(relations, index);
    body.dataset.loaded = "true";
    updateReferenceCount(group);
  } catch (error) {
    if (session !== state.drawerSession || !drawer.open || !group.isConnected) return;
    console.error(error);
    body.innerHTML = '<p role="status">来源记录加载失败。<button type="button" class="text-button" data-retry-evidence>重新加载</button></p>';
  }
}

function updateReferenceCount(group) {
  const count = group.querySelectorAll('input[name="reference"]:checked').length;
  const button = group.querySelector("[data-select-references]");
  button.textContent = count ? `已勾选 ${count} 条` : "选择引用";
  button.setAttribute("aria-label", `${group.querySelector(".appendix-toggle .mono").textContent} ${button.textContent}`);
}

function renderReviewHistory() {
  const history = state.gene.relationships.flatMap((relation) => {
    const review = getReview(relation);
    if (!review.reviewedAt) return [];
    return [review, ...(review.history ?? [])].map((entry) => ({...entry, mode: modeText(relation)}));
  }).sort((left, right) => right.reviewedAt.localeCompare(left.reviewedAt));
  $("#review-history").innerHTML = history.map((entry) =>
    `<li>${escape(entry.mode)} · ${statusLabels[entry.status]} <time datetime="${escape(entry.reviewedAt)}">${escape(formatReviewTime(entry.reviewedAt))}</time></li>`
  ).join("") || "<li>暂无操作</li>";
}

async function openDrawer(disease, gene, trigger) {
  const session = ++state.drawerSession;
  state.drawerDisease = disease;
  state.gene = gene;
  state.drawerTrigger = trigger;
  const focusKey = trigger?.dataset.relationOpen;
  renderDrawer();
  drawer.showModal();
  drawer.querySelector(".drawer-scroll").scrollTop = 0;
  const groups = [...drawer.querySelectorAll(".appendix-group")];
  const focused = state.drawerGroups.findIndex((group) => group.some((relation) => relation.entity_id === focusKey));
  for (const [index, group] of groups.entries()) {
    if (index !== focused && !state.fold && group.hasAttribute("data-noise")) setEvidenceGroupOpen(group, true);
  }
  (groups[focused]?.querySelector("[data-group-toggle]") || $("#drawer-close")).focus();
  if (focused === -1) return;
  await setEvidenceGroupOpen(groups[focused], true);
  if (session !== state.drawerSession || !drawer.open) return;
  const form = focusKey && drawer.querySelector(`[data-relationship="${CSS.escape(focusKey)}"]`);
  if (form && trigger.classList.contains("mode-review") &&
      document.activeElement === groups[focused].querySelector("[data-group-toggle]")) form.querySelector("select").focus();
}

function saveRelationshipReview(form) {
  const {drawerDisease: disease, gene} = state;
  const relation = gene.relationships.find((item) => item.entity_id === form.dataset.relationship);
  const fields = new FormData(form);
  const status = fields.get("status");
  const note = fields.get("note").trim();
  const evidence = fields.getAll("reference").map((index) => evidenceReference(relation.evidence[Number(index)]));
  const feedback = form.querySelector("[data-review-feedback]");
  if (status === "confirmed" && !evidence.length) {
    feedback.textContent = "采信时请勾选至少一条引用记录。";
    [...form.elements].find((field) => field.name === "reference")?.focus();
    return;
  }
  const storageKey = reviewPrefix + relation.entity_id;
  let review;
  try {
    readStoredReview(relation.entity_id, localStorage.getItem(storageKey));
    const {history = [], ...previous} = getReview(relation);
    if ((previous.reviewedAt ?? "") !== form.dataset.reviewedAt) {
      feedback.textContent = "这条关系的复核已在另一标签页更新。请重新打开详情后保存。";
      return;
    }
    review = {
      disease: disease.title, diseaseId: disease.entity_id, gene: gene.symbol, hgncId: gene.hgnc_id,
      inheritance: modeText(relation), inheritanceId: relation.inheritance_id,
      ...(relation.inheritance_ids && {inheritanceIds: relation.inheritance_ids}),
      relationshipKey: relation.entity_id, status, note, evidence,
      reviewedAt: new Date().toISOString(), knowledgeBaseVersion: state.knowledgeBaseVersion,
      history: previous.reviewedAt ? [{status: previous.status, note: previous.note, evidence: previous.evidence,
        reviewedAt: previous.reviewedAt, knowledgeBaseVersion: previous.knowledgeBaseVersion}, ...history] : []
    };
    localStorage.setItem(storageKey, JSON.stringify(review));
  } catch (error) {
    console.warn("无法保存复核记录", error);
    feedback.textContent = "浏览器存储不可用，保存失败。";
    return;
  }
  state.reviews.set(relation.entity_id, review);
  form.dataset.reviewedAt = review.reviewedAt;
  const statusBadge = form.querySelector("[data-review-status]");
  statusBadge.className = `mode-state ${status}`;
  statusBadge.textContent = statusLabels[status];
  form.querySelector("[data-review-metadata]").innerHTML = reviewMetadata(review);
  form.querySelector("[data-previous-version]").textContent = "";
  feedback.textContent = "已保存";
  renderDrawerSummary();
  renderReviewHistory();
  renderWorkspace();
}

function restoreDrawerFocus() {
  const trigger = state.drawerTrigger;
  state.drawerTrigger = null;
  if (trigger?.isConnected && trigger.getClientRects().length) {
    trigger.focus();
    return;
  }
  const rowId = trigger?.closest(".gene-row")?.id;
  const row = rowId && document.getElementById(rowId);
  const selector = trigger?.dataset.relationOpen
    ? `[data-relation-open="${CSS.escape(trigger.dataset.relationOpen)}"]${trigger.classList.contains("conflict-link") ? ".conflict-link" : ".mode-review"}`
    : trigger?.classList.contains("evidence-count") ? ".evidence-count" : ".gene-main";
  const replacement = row && row.querySelector(selector);
  (replacement?.getClientRects().length ? replacement : row?.querySelector(".gene-main") ||
    $("#filter-pills [aria-pressed=true]"))?.focus();
}

function snapshotRow({history, ...review}) {
  const changes = previousReviewChanges(review);
  const qualified = new Map(changes.map(({source, recordId, rawPath, rawLocator, ...details}) => [
    evidenceKey({source, recordId, rawPath, rawLocator}), details
  ]));
  const evidence = review.evidence.map((reference) => {
    const adjusted = {...reference, ...qualified.get(evidenceKey(reference))};
    if (adjusted.relationshipRole === "modifier") adjusted.relationshipRoleLabel = modifierLabel;
    return adjusted;
  });
  const modifier = evidence.some(({relationshipRole}) => relationshipRole === "modifier");
  const replacementRelationshipKeys = unique(changes.map(({newRelationshipKey}) => newRelationshipKey));
  const disease = state.catalog.get(review.diseaseId);
  return {
    ...review, evidence, status: statusLabels.confirmed,
    ...(modifier && {relationshipRole: "modifier", relationshipRoleLabel: `${modifierLabel}（OMIM）`}),
    ...(replacementRelationshipKeys.length && {inheritanceNote: "按旧关系键复核，待重新确认", replacementRelationshipKeys}),
    ...(disease?.zh && {diseaseZh: disease.zh}),
    replacementIds: disease?.replaced_by ?? []
  };
}

function snapshotInheritance(row) {
  return row.inheritanceNote ? `${row.inheritance}（${row.inheritanceNote}）` :
    row.inheritanceId === omimAdAndAr ? omimInheritanceLabel : row.inheritance;
}

function renderSnapshot() {
  const currentView = $("#export-scope-current").checked;
  const relations = relationshipRows(activeAssociations());
  const previousKeys = unique(relations.flatMap(({previous_keys}) => previous_keys ?? []));
  const liveKeys = new Set(relations.map(({entity_id}) => entity_id));
  const previous = previousKeys.filter((key) => !liveKeys.has(key)).map((key) => state.reviews.get(key))
    .filter((entry) => entry && reviewNeedsConfirmation(entry));
  const reviews = currentView ? [...relations.map(getReview), ...previous] : [...state.reviews.values()];
  const rows = reviews.filter(({status}) => status === "confirmed").map(snapshotRow)
    .sort((left, right) => left.relationshipKey.localeCompare(right.relationshipKey));
  state.snapshotRows = rows;
  const subject = currentView ? state.genePage?.gene.symbol ?? displayName(state.disease) : "此浏览器全部采信";
  $("#export-title").textContent = `${subject} · ${rows.length} 条采信`;
  const disease = state.disease;
  const context = currentView && disease ? state.scope === "merged" ?
    (disease.disease_branch ? "合并关联疾病及亚型" : "合并下属亚型") : "仅看当前概念" : "";
  $("#export-summary").textContent = [
    context, `已复核 ${reviews.filter(({status}) => status !== "pending").length} 条关系键`
  ].filter(Boolean).join(" · ");
  $("#export-table-body").innerHTML = rows.map((row) => `<tr>
    <td><span class="mono">${escape(row.gene)}</span>
      ${row.relationshipRoleLabel ? `<div class="snapshot-locator">${escape(row.relationshipRoleLabel)}</div>` : ""}</td>
    <td>${row.diseaseZh ? `${escape(row.diseaseZh)}<br>` : ""}<span lang="en">${escape(row.disease)}</span><br><code>${escape(row.diseaseId)}</code>
      ${row.replacementIds.length ? `<div class="snapshot-locator">替代编号 ${row.replacementIds.map((id) => `<code>${escape(id)}</code>`).join(" · ")}</div>` : ""}</td>
    <td>${escape(snapshotInheritance(row))}${(row.replacementRelationshipKeys ?? []).map((key) =>
      `<div class="snapshot-locator"><code>${escape(key)}</code></div>`).join("")}</td><td>${escape(row.note || "—")}</td>
    <td>${row.evidence.map((item) => `<div>${escape(item.source)} · <code>${escape(item.recordId)}</code>
      ${item.inheritanceIds?.length === 2 ? `<div class="snapshot-locator">${omimInheritanceLabel}</div>` : ""}
      ${item.sourceInheritance ? `<div class="snapshot-locator" lang="en">${escape(item.sourceInheritance)}</div>` : ""}
      ${item.relationshipRoleLabel ? `<div class="snapshot-locator">${escape(item.relationshipRoleLabel)}</div>` : ""}
      <div class="snapshot-locator">${escape(item.rawPath)} · ${escape(JSON.stringify(item.rawLocator))}</div></div>`).join("")}</td></tr>`).join("") ||
    '<tr><td colspan="5">暂无采信关系。可在证据抽屉选择采信并引用来源记录。</td></tr>';
  $("#copy-json").disabled = $("#copy-table").disabled = !rows.length;
  $("#manual-copy").hidden = true;
}

function openSnapshot(trigger) {
  state.modalTrigger = trigger;
  $("#export-scope-current").checked = true;
  renderSnapshot();
  modal.showModal();
  $("#export-close").focus();
}

async function copySnapshot(format) {
  const rows = state.snapshotRows;
  if (!rows.length) return;
  const fields = ["gene", "relationshipRoleLabel", "diseaseZh", "disease", "diseaseId", "replacementIds", "inheritance", "relationshipKey", "note", "evidence", "reviewedAt", "knowledgeBaseVersion"];
  const headers = ["基因", "关联角色", "中文名称", "英文名称", "复核时的编号", "替代编号", "遗传模式", "关系键", "理由", "引用的来源记录", "复核时间", "知识库版本"];
  const cell = (value) => {
    const text = (Array.isArray(value) ? JSON.stringify(value) : String(value ?? "")).replace(/[\t\r\n]+/g, " ");
    return /^[=+\-@]/.test(text.trimStart()) ? `'${text}` : text;
  };
  const tableRows = rows.map((row) => ({
    ...row, replacementIds: row.replacementIds.join(" · "), inheritance: snapshotInheritance(row)
  }));
  const content = format === "json" ? JSON.stringify(rows, null, 2) :
    [headers, ...tableRows.map((row) => fields.map((field) => cell(row[field])))].map((row) => row.join("\t")).join("\n");
  try {
    await navigator.clipboard.writeText(content);
    notify("快照已复制");
  } catch {
    if (state.snapshotRows !== rows || !modal.open) return;
    const fallback = $("#manual-copy");
    fallback.hidden = false;
    fallback.value = content;
    fallback.select();
    notify("请复制已选中的内容");
  }
}


function bindEvents() {
  $("#home-link").addEventListener("click", (event) => {
    if (!location.hash || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    history.pushState(null, "", location.pathname + location.search);
    readRoute();
    $("#page-title").focus({preventScroll: true});
    window.scrollTo(0, 0);
  });
  search.addEventListener("input", () => {
    $("#clear-search").hidden = !search.value;
    renderSuggestions();
  });
  search.addEventListener("keydown", (event) => {
    if (event.isComposing || event.keyCode === 229) return;
    if (event.key === "Escape") {
      dismissSuggestions();
      return;
    }
    if (suggestions.hidden) return;
    const options = [...suggestions.querySelectorAll("button")];
    if (event.key === "Enter") {
      event.preventDefault();
      const best = options.reduce((current, option) =>
        !current || Number(option.dataset.score) > Number(current.dataset.score) ? option : current, null);
      (options[state.activeResult] || best)?.click();
    }
    if (["ArrowDown", "ArrowUp"].includes(event.key) && options.length) {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      state.activeResult = state.activeResult < 0
        ? (step === 1 ? 0 : options.length - 1)
        : (state.activeResult + step + options.length) % options.length;
      options.forEach((option, index) => option.classList.toggle("active", index === state.activeResult));
      options[state.activeResult].scrollIntoView({ block: "nearest" });
    }
  });
  $("#clear-search").addEventListener("click", () => {
    search.value = "";
    $("#clear-search").hidden = true;
    dismissSuggestions();
    search.focus();
  });
  $("#retry-details").addEventListener("click", () => showWorkspace(true));
  $("#disease-overview").addEventListener("input", (event) => {
    if (event.target.id !== "feature-search") return;
    const query = foldText(event.target.value);
    let shown = 0;
    for (const item of event.target.closest(".feature-panel").querySelectorAll("[data-feature-terms]")) {
      item.hidden = !item.dataset.featureTerms.includes(query);
      if (!item.hidden) shown++;
    }
    $("#feature-count").textContent = shown ? `显示 ${shown} 项` : "未找到匹配的临床特征";
  });
  for (const list of [suggestions, $("#sample-list"), $("#disease-overview")]) {
    list.addEventListener("click", (event) => {
      const button = event.target.closest("[data-disease], [data-gene]");
      if (!button) return;
      if (button.matches("a")) {
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
      }
      if (button.dataset.disease) selectDisease(button.dataset.disease);
      else selectGene(button.dataset.gene);
    });
  }
  $("#association-scope").addEventListener("click", async (event) => {
    const scope = event.target.closest("[data-scope]")?.dataset.scope;
    if (!scope || scope === state.scope) return;
    if (scope === "merged") {
      const selection = state.selection;
      const button = event.target.closest("[data-scope]");
      button.disabled = true;
      try {
        const pages = await Promise.all(state.disease.scope_ids.map(loadDisease));
        if (selection !== state.selection) return;
        state.scopePages = pages;
      } catch (error) {
        if (selection !== state.selection) return;
        console.error(error);
        notify("关联范围加载失败，请重试");
        return;
      } finally {
        button.disabled = false;
      }
    }
    state.scope = scope;
    renderWorkspace();
    $("#association-scope [aria-pressed=true]").focus();
  });
  const guide = $(".evidence-legend");
  guide.addEventListener("toggle", async () => {
    if (!guide.open || guide.dataset.loaded) return;
    $("#source-field-guide").textContent = "正在加载来源字段…";
    try {
      renderSourceFieldGuide(await loadPart("source-fields"));
      guide.dataset.loaded = "true";
    } catch (error) {
      console.error(error);
      $("#source-field-guide").textContent = "来源字段加载失败，可重新展开重试。";
    }
  });
  document.addEventListener("click", (event) => {
    if (!$("#search-wrap").contains(event.target)) dismissSuggestions();
  });
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && !drawer.open && !modal.open) {
      event.preventDefault();
      search.focus();
      search.select();
    }
  });

  $("#filter-pills").addEventListener("click", (event) => {
    const filter = event.target.closest("[data-filter]")?.dataset.filter;
    if (!filter) return;
    state.filter = filter;
    renderWorkspace();
    $("#filter-pills").querySelector("[aria-pressed=true]").focus();
  });
  $("#gene-list").addEventListener("click", (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const {aggregate} = button.dataset;
    if (aggregate) {
      const expanded = !state.expandedGenes.has(aggregate);
      if (expanded) state.expandedGenes.add(aggregate);
      else state.expandedGenes.delete(aggregate);
      button.setAttribute("aria-expanded", expanded);
      document.getElementById(button.getAttribute("aria-controls")).hidden = !expanded;
      return;
    }
    const row = button.closest(".gene-row");
    if (button.hasAttribute("data-row-details")) {
      const expanded = row.classList.toggle("details-open");
      button.setAttribute("aria-expanded", expanded);
      button.textContent = expanded ? "收起证据与标识" : "展开证据与标识";
      return;
    }
    if (button.dataset.disease) return selectDisease(button.dataset.disease);
    if (button.dataset.gene) return selectGene(button.dataset.gene);
    const entry = activeAssociations().find(({disease, gene}) =>
      disease.entity_id === row.dataset.concept && gene.hgnc_id === row.dataset.hgnc);
    if (entry) openDrawer(entry.disease, entry.gene, button);
  });
  const noiseSwitches = [$("#noise-toggle"), $("#drawer-noise-toggle")];
  for (const control of noiseSwitches) {
    control.addEventListener("change", () => {
      state.fold = control.checked;
      noiseSwitches.forEach((input) => input.checked = state.fold);
      drawer.querySelectorAll("[data-noise]").forEach((group) => setEvidenceGroupOpen(group, !state.fold));
    });
  }
  $("#relationship-groups").addEventListener("submit", (event) => {
    event.preventDefault();
    saveRelationshipReview(event.target);
  });
  $("#relationship-groups").addEventListener("input", (event) => {
    const feedback = event.target.form?.querySelector("[data-review-feedback]");
    if (feedback) feedback.textContent = "";
    if (event.target.name === "reference") updateReferenceCount(event.target.closest(".appendix-group"));
  });
  $("#relationship-groups").addEventListener("click", async (event) => {
    const button = event.target.closest("button");
    if (!button) return;
    const group = button.closest(".appendix-group");
    if (button.hasAttribute("data-group-toggle")) {
      setEvidenceGroupOpen(group, button.getAttribute("aria-expanded") !== "true");
    } else if (button.hasAttribute("data-retry-evidence")) {
      await setEvidenceGroupOpen(group, true);
      if (group.isConnected && drawer.open) group.querySelector("[data-group-toggle]").focus();
    } else if (button.hasAttribute("data-select-references")) {
      await setEvidenceGroupOpen(group, true);
      if (group.isConnected && drawer.open && document.activeElement === button) {
        group.querySelector('[name="reference"]')?.focus();
      }
    } else if (button.hasAttribute("data-record-toggle")) {
      const record = document.getElementById(button.getAttribute("aria-controls"));
      record.hidden = !record.hidden;
      button.setAttribute("aria-expanded", !record.hidden);
    } else if (button.hasAttribute("data-copy-key")) {
      const key = button.previousElementSibling;
      const feedback = $("#drawer-feedback");
      try {
        await navigator.clipboard.writeText(key.textContent);
        feedback.textContent = "关系键已复制";
      } catch {
        const range = document.createRange();
        range.selectNodeContents(key);
        const selection = window.getSelection();
        selection.removeAllRanges();
        selection.addRange(range);
        feedback.textContent = "关系键已选中，可复制";
      }
    }
  });
  window.addEventListener("storage", async (event) => {
    const key = event.key?.slice(reviewPrefix.length);
    if (event.key === null) state.reviews.clear();
    else if (event.key.startsWith(reviewPrefix)) readStoredReview(key, event.newValue);
    else return;
    try {
      await loadReviewAdjustments();
    } catch (error) {
      console.error(error);
    }
    if (state.disease || state.genePage) renderWorkspace();
    if (modal.open) renderSnapshot();
    if (drawer.open) {
      for (const relation of state.gene?.relationships ?? []) {
        if (event.key !== null && key !== relation.entity_id && !relation.previous_keys?.includes(key)) continue;
        const review = getReview(relation);
        const card = drawer.querySelector(`[data-relationship="${CSS.escape(relation.entity_id)}"]`);
        if (!card) continue;
        card.querySelector("[data-review-feedback]").textContent = "这条关系的复核已在另一标签页更新。重新打开详情可读取最新版本。";
        const badge = card.querySelector("[data-review-status]");
        badge.className = `mode-state ${review.status}`;
        badge.textContent = statusLabels[review.status];
      }
      renderDrawerSummary();
      renderReviewHistory();
    }
  });
  for (const button of [$("#export-open"), $("#drawer-snapshot")]) {
    button.addEventListener("click", (event) => openSnapshot(event.currentTarget));
  }
  $("#export-scope").addEventListener("change", renderSnapshot);
  $("#copy-json").addEventListener("click", () => copySnapshot("json"));
  $("#copy-table").addEventListener("click", () => copySnapshot("table"));
  for (const [dialog, close] of [[drawer, "#drawer-close"], [modal, "#export-close"]]) {
    $(close).addEventListener("click", () => dialog.close());
    dialog.addEventListener("click", (event) => {
      if (event.target !== dialog) return;
      const rect = dialog.getBoundingClientRect();
      if (event.clientX < rect.left || event.clientX > rect.right ||
          event.clientY < rect.top || event.clientY > rect.bottom) dialog.close();
    });
  }
  drawer.addEventListener("close", () => {
    ++state.drawerSession;
    state.gene = null;
    state.drawerDisease = null;
    restoreDrawerFocus();
  });
  modal.addEventListener("close", () => {
    $("#manual-copy").hidden = true;
    state.modalTrigger?.focus();
  });
}

function configuredDataBaseUrl() {
  // The build and local server may provide the public value through either a
  // global or the document data attribute. Keeping both forms makes the shell
  // usable as a plain static file while allowing the build to inject config.
  const fromGlobal = typeof window.PEAINDEX_DATA_BASE_URL === "string"
    ? window.PEAINDEX_DATA_BASE_URL : "";
  const meta = document.querySelector('meta[name="peaindex-data-base-url"]');
  const fromMeta = meta?.content || "";
  const fromDocument = document.documentElement.dataset.dataBaseUrl || "";
  return (fromGlobal || fromMeta || fromDocument).trim();
}

function resolveDataUrl(relativePath) {
  const configured = configuredDataBaseUrl();
  const base = configured || new URL("/data/", window.location.origin).href;
  const absoluteBase = new URL(base, window.location.origin).href;
  const normalizedBase = absoluteBase.endsWith("/") ? absoluteBase : `${absoluteBase}/`;
  return new URL(relativePath.replace(/^\/+/, ""), normalizedBase).href;
}

async function fetchData(path, options) {
  const response = await fetch(resolveDataUrl(path), options);
  if (!response.ok) throw new Error(`${path} 加载失败 (${response.status})`);
  return response.json();
}

async function loadCatalog() {
  const options = {cache: "no-cache"};
  if (typeof DecompressionStream !== "undefined") {
    try {
      const response = await fetch(resolveDataUrl("catalog.json.gz"), options);
      if (!response.ok) throw new Error(`检索目录加载失败 (${response.status})`);
      if (!response.body) throw new Error("压缩目录响应为空");
      return await new Response(response.body.pipeThrough(new DecompressionStream("gzip"))).json();
    } catch (error) {
      console.warn("压缩检索目录不可用，回退到 catalog.json", error);
    }
  }
  return fetchData("catalog.json", options);
}

function loadPart(kind, id) {
  const name = id ? kind + "/" + encodeURIComponent(id) : kind;
  if (!state.requests.has(name)) {
    const request = fetchData("library/" + state.generation + "/" + name + ".json").catch((error) => {
      state.requests.delete(name);
      throw error;
    });
    state.requests.set(name, request);
  }
  return state.requests.get(name);
}

async function loadDisease(id) {
  const {genes, ...detail} = await loadPart("disease", id);
  return {...state.catalog.get(id), ...detail, genes: genes.map(([geneId, location, relationships]) => ({
    ...state.geneIndex.get(geneId).gene, location, relationships
  })).sort((left, right) => Number(strong(right)) - Number(strong(left)) || left.symbol.localeCompare(right.symbol))};
}

async function loadGene(id) {
  const entry = state.geneIndex.get(id);
  const {info, associations} = await loadPart("gene", id);
  const gene = {...entry.gene, ...info};
  return {gene, associations: associations.map(([diseaseId, relationships]) => ({
    disease: state.catalog.get(diseaseId), gene: {...gene, relationships}
  })).sort((left, right) => Number(strong(right.gene)) - Number(strong(left.gene)) ||
    Number(Boolean(left.disease.obsolete)) - Number(Boolean(right.disease.obsolete)) ||
    left.disease.title.localeCompare(right.disease.title))};
}

async function loadReviewAdjustments() {
  if ([...state.reviews.values()].some((review) => review.knowledgeBaseVersion !== state.knowledgeBaseVersion)) {
    state.adjustments = await loadPart("review-adjustments");
  }
}

async function boot() {
  try {
    const {diseases, genes, generation, knowledge_base_version, input_version} = await loadCatalog();
    state.generation = generation;
    state.knowledgeBaseVersion = knowledge_base_version;
    state.inputVersion = input_version;
    $("#library-meta").textContent = `本地全库 · ${genes.length.toLocaleString("zh-CN")} 基因`;
    loadReviews();
    for (const disease of diseases) {
      const sample = samples[disease.entity_id];
      disease.terms = searchTerms([disease.entity_id, disease.title, disease.zh, ...disease.search_terms,
        sample?.title, ...(sample?.aliases ?? [])]);
      state.catalog.set(disease.entity_id, disease);
    }
    for (const gene of genes) {
      const exactKeys = [gene.symbol, gene.hgnc_id].map(normalizedText);
      const keys = searchTerms(exactKeys);
      const terms = searchTerms([gene.name, ...(gene.alias_symbol ?? []), ...(gene.prev_symbol ?? []),
        ...(gene.omim_id ?? []).map((id) => `OMIM:${id}`)]);
      state.geneIndex.set(gene.hgnc_id, {gene, exactKeys, keys, terms: unique([...keys, ...terms])});
    }
    const examples = Object.keys(samples).map((id) => state.catalog.get(id)).filter(Boolean);
    $("#sample-list").innerHTML = examples.map(({entity_id: id, zh, title}) =>
      `<li><a class="sample-row" href="#${new URLSearchParams({disease: id})}" data-disease="${escape(id)}">
        <strong>${escape(zh || title)}</strong><span lang="en">${escape(title)}</span>
        <code>${escape(id)}</code><span class="chevron" aria-hidden="true"></span>
      </a></li>`).join("");
    $("#sample-index").hidden = !examples.length;
    $("#search-shortcut").textContent = /mac/i.test(navigator.platform) ? "⌘ K" : "Ctrl K";
    search.disabled = false;
    bindEvents();
    window.addEventListener("hashchange", readRoute);
    readRoute();
  } catch (error) {
    console.error(error);
    $("#load-error").hidden = false;
  }
}

boot();

