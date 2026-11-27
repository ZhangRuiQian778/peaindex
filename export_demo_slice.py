"""Build and reconcile the full PeaIndex data served by the static demo."""

import argparse
from collections import Counter, defaultdict
import csv
import gzip
import hashlib
from itertools import chain, zip_longest
import json
from pathlib import Path
import re
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parent
TOPICS = ROOT / ".wiki/wiki/topics"
WIKI = TOPICS / "full-5344"
NORMALIZED = ROOT / "data/full-5344/normalized"
STAGING = ROOT / "data/full-5344/staging"
EVIDENCE = NORMALIZED / "gene-disease-evidence.jsonl"
DISEASE_NORMALIZATION = NORMALIZED / "disease-normalization.jsonl"
DATA_ROOT = ROOT / "external-data"
MONDO = STAGING / "mondo/mondo-base.obo"
MONDO_MAPPINGS = STAGING / "mondo/mondo.sssom.tsv"
HPO = STAGING / "terminology/hp.obo"
HPO_ANNOTATIONS = STAGING / "terminology/phenotype.hpoa.gz"
CHPO = STAGING / "terminology/chpo.csv"
ZH_CATALOG = ROOT / "data/full-5344/localization/zh-CN.json"
OMIM_DISEASE_ARCHIVES = (STAGING / "omim", ROOT / "data/pilot-20/staging/omim-api")
CHPO_URL = "https://github.com/pzweuj/PhenoCHPO/blob/main/data/chpo_dict.csv"

# The cross-ontology links listed here must also exist as explicit MONDO feature edges.
FEATURE_BRANCHES = {
    "HP:0010980": ("MONDO:0037748", "disease_has_major_feature"),
    "HP:0003124": ("MONDO:0005439", "disease_has_feature"),
}
BRANCH_ROOTS = {"MONDO:0007947", "MONDO:0100135", "MONDO:0010975", *FEATURE_BRANCHES}
LOCAL_TERMS = {
    "HP:0010980": ("高脂蛋白血症", ["高脂蛋白血"]),
    "MONDO:0037748": ("高脂蛋白血症（疾病分类）", ["脂蛋白血症"]),
    "MONDO:0005439": ("家族性高胆固醇血症", ["家族性高胆固醇", "家族性高胆固醇症", "家族性高胆固醇血", "FH"]),
    "MONDO:0007750": ("家族性高胆固醇血症 1 型", ["家族性高胆固醇血症1型", "LDLR 相关家族性高胆固醇血症", "FHCL1"]),
    "MONDO:0007751": ("家族性高胆固醇血症 2 型", []),
    "MONDO:0011369": ("家族性高胆固醇血症 3 型", []),
    "MONDO:0011374": ("家族性高胆固醇血症 4 型", []),
    "MONDO:0018328": ("纯合子型家族性高胆固醇血症", ["纯合子家族性高胆固醇血症", "HoFH"]),
    "MONDO:0007947": ("马凡综合征", ["马方综合征", "马凡氏综合征", "馬凡氏症候群", "Marfan 综合征", "MFS"]),
    "MONDO:0017309": ("新生儿马凡综合征", []),
    "MONDO:0100135": ("德拉韦综合征", ["Dravet 综合征", "德拉韦特综合征", "婴儿严重肌阵挛性癫痫", "SMEI"]),
    "MONDO:0009279": ("三 A 综合征", ["三A综合征", "三 A 症候群", "Allgrove 综合征"]),
    "MONDO:0010975": ("致心律失常性右室发育不良 2 型", ["ARVD2", "致心律失常性右室心肌病 2 型"]),
}
UNNAMED_TERMS = {
    "MONDO:000855": ("未核实的 MONDO 条目", "Unverified MONDO entry"),
    "OMIM:612186": ("未核实的 OMIM 关联条目", "Unverified OMIM association"),
}
HAN = re.compile(r"[\u3400-\u9fff]")
ORPHA_LABELS = {
    "MONDO:0007947": "Orphanet:558",
    "MONDO:0017309": "Orphanet:284979",
    "MONDO:0018328": "Orphanet:391665",
    "MONDO:0100135": "Orphanet:33069",
}
CLINICAL_FEATURE_ZH = {
    "HP:0003141": "循环 LDL 胆固醇浓度升高",
}
TERM_ID = r"(?:MONDO|HP):\d+"
OBO_DEFINITION = re.compile(r'^def: "((?:\\.|[^"\\\n])*)"[ \t]+\[((?:\\.|[^\\\]\n])*)\]', re.M)
OMIM_ID = re.compile(r"OMIM:(\d{6})\Z")
OMIM_AD_AND_AR = "AUTOSOMAL_DOMINANT_AND_RECESSIVE"
OMIM_MODES = {"HP:0000006": "autosomal dominant", "HP:0000007": "autosomal recessive"}
RATING_TIERS = ("Definitive", "Strong", "Moderate", "Supportive", "Limited")
CONTESTED_RATINGS = ("Disputed Evidence", "Refuted Evidence", "No Known Disease Relationship", "Refuted")
RATING_SOURCES = ("GenCC", "SysNDD")
MAPPING_FIELDS = ("source", "source_disease_id", "source_disease_label", "normalized_disease_id",
                  "normalized_disease_label", "disease_mapping_status")

# Match the exact source and the English passages used by each local translation.
TRANSLATED_EXCERPTS = {
    "MONDO:0007947": (
        "MONDO:0007947",
        ("A disorder of the connective tissue.",
         "Marfan syndrome affects most organs and tissues, especially the skeleton, lungs, eyes, heart, and the large blood vessel that distributes blood from the heart to the rest of the body (the aorta)."),
        "马凡综合征是一种结缔组织疾病。它累及大多数器官和组织，尤其是骨骼、肺、眼、心脏和主动脉。",
    ),
    "MONDO:0030268": (
        "OMIM:619317",
        ("Developmental and epileptic encephalopathy-6B (DEE6B) is a severe neurodevelopmental disorder characterized by early-infantile seizure onset, profoundly impaired intellectual development, and a hyperkinetic movement disorder.",
         "Brain imaging usually shows progressive atrophy and other abnormalities"),
        "发育性与癫痫性脑病 6B 型是一种重度神经发育障碍，特征包括婴儿早期起病的癫痫发作、重度智力发育受损和过度运动性运动障碍。脑影像通常可见进行性萎缩及其他异常。",
    ),
}


def usable_text(value):
    text = (value or "").strip()
    placeholders = {"", "校对中", "校對中", "待校对", "待翻译", "翻译中", "待补充", "暂无", "n/a", "null"}
    return text if text.strip(" .…。—–-").casefold() not in placeholders else ""


def obo_definition(block):
    match = OBO_DEFINITION.search(block)
    if not match:
        return None
    escapes = {"n": "\n", "t": "\t", "W": " "}
    text = re.sub(r"\\(.)", lambda m: escapes.get(m[1], m[1]), match[1])
    if not usable_text(text):
        return None
    references = re.split(r"(?<!\\),\s*", match[2]) if match[2] else []
    return {"original": text, "references": references}


def ontology(path, prefix):
    text = path.read_text(encoding="utf-8")
    version = re.search(r"^data-version: (.+)", text, re.M)[1]
    terms = {}
    for block in text.split("\n[Term]\n")[1:]:
        block = block.split("\n[Typedef]\n", 1)[0]
        term_id = re.search(rf"^id: ({prefix}:\d+)$", block, re.M)
        if term_id is None:
            continue
        terms[term_id[1]] = {
            "title": re.search(r"^name: (.+)", block, re.M)[1],
            "definition": obo_definition(block),
            "parents": re.findall(rf"^is_a: ({TERM_ID})", block, re.M),
            "features": re.findall(r"^relationship: (disease_has_(?:major_)?feature) (HP:\d+)", block, re.M),
            "aliases": re.findall(r'^synonym: "((?:\\.|[^"\\])*)" EXACT\b', block, re.M),
            "xrefs": re.findall(r"^xref: ((?:OMIM|Orphanet):\d+)", block, re.M),
            "replaced_by": re.findall(r"^replaced_by: (\S+)", block, re.M),
            "merged": bool(re.search(r"^property_value: IAO:0000231 MONDO:TermsMerged\b", block, re.M)),
            "obsolete": "is_obsolete: true" in block,
        }
    return terms, version


def exact_disease_ids(mondo):
    mapped = defaultdict(set)
    with MONDO_MAPPINGS.open(encoding="utf-8", newline="") as source:
        rows = csv.DictReader((line for line in source if not line.startswith("#")), delimiter="\t")
        for row in rows:
            concept_id = row["subject_id"]
            disease_id = row["object_id"].replace("Orphanet:", "ORPHA:", 1)
            if row["predicate_id"] != "skos:exactMatch" or concept_id not in mondo:
                continue
            if not disease_id.startswith(("OMIM:", "ORPHA:", "DECIPHER:")):
                continue
            mapped[concept_id].add(disease_id)
    return mapped


def clinical_disease_ids(mondo, exact_ids):
    mapped = defaultdict(set, {term_id: ids.copy() for term_id, ids in exact_ids.items()})
    for concept_id, ids in exact_ids.items():
        term = mondo[concept_id]
        if term["obsolete"] and len(term["replaced_by"]) == 1:
            mapped[term["replaced_by"][0]].update(ids)
    return mapped


def ontology_definition(concept_id, term, version):
    definition = term.get("definition")
    if not definition:
        return None
    is_phenotype = concept_id.startswith("HP:")
    ontology_id = "hp" if is_phenotype else "mondo"
    url = f"https://www.ebi.ac.uk/ols4/ontologies/{ontology_id}/terms?obo_id={concept_id}"
    return {
        **definition, "source": "HPO" if is_phenotype else "MONDO",
        "version": version, "entry_id": concept_id, "url": url,
    }


def omim_definition(omim_id):
    number = OMIM_ID.fullmatch(omim_id)[1]
    for directory in OMIM_DISEASE_ARCHIVES:
        path = directory / f"disease-{number}.json"
        if not path.is_file():
            continue
        archive = json.loads(path.read_text(encoding="utf-8"))
        entry = archive.get("entry") or {}
        # OMIM's numeric identifier and entry prefix distinguish diseases from gene records.
        if str(entry.get("mimNumber")) != number or entry.get("prefix") not in {"#", "%", "", " "} or entry.get("status") != "live":
            continue
        for section in entry.get("textSectionList") or []:
            section = section.get("textSection") or {}
            if section.get("textSectionName") != "description":
                continue
            description = section.get("textSectionContent")
            version = entry.get("dateUpdated") or archive.get("fetched")
            if usable_text(description) and version:
                return {
                    "original": description, "references": [], "source": "OMIM",
                    "version": version, "version_label": "条目更新" if entry.get("dateUpdated") else "本地快照",
                    "entry_id": omim_id, "url": f"https://omim.org/entry/{number}#description",
                    "archive": path.relative_to(ROOT).as_posix(),
                }
    return None


def wiki_overview(concept_id, definition):
    slug = concept_id.lower().replace(":", "-")
    for kind in ("phenotype", "disease") if concept_id.startswith("HP:") else ("disease",):
        path = TOPICS / f"{kind}-{slug}.md"
        if not path.is_file():
            continue
        document = re.match(r"\A---\n(.*?)\n---\n(.*)\Z", path.read_text(encoding="utf-8"), re.S)
        if not document:
            continue
        frontmatter, body = document.groups()
        entity_id = re.search(r"""^entity_id:\s*["']?([\w:]+)["']?\s*$""", frontmatter, re.M)
        if not entity_id or entity_id[1] != concept_id:
            continue
        section = re.search(r"^## (?:疾病概述|表型定义|概述)[ \t]*\n+(.+?)(?=^#{1,2} |\Z)", body, re.M | re.S)
        if not section:
            continue
        approved_urls = {definition["url"], *definition["references"]}
        if definition["source"] in {"MONDO", "HPO"}:
            approved_urls.add(f"https://purl.obolibrary.org/obo/{concept_id.replace(':', '_')}")
        paragraph = re.split(r"\n[ \t]*\n", section[1].strip(), maxsplit=1)[0]
        citation = re.fullmatch(r"(.*?)\s*\[[^\]]+\]\((https?://[^)\s]+)\)[。]?", paragraph, re.S)
        if citation and citation[2] in approved_urls and re.search(r"[\u3400-\u9fff]", citation[1]):
            return {
                "kind": "wiki", "text": first_two_sentences(citation[1].strip(), chinese=True),
                "wiki_path": path.relative_to(ROOT).as_posix(), "wiki_reference": citation[2],
            }
    return None


def first_two_sentences(text, chinese=False):
    if chinese:
        return "".join(re.findall(r"[^。！？]+[。！？]*", text)[:2])
    text = re.split(r"\n\s*\n", text.strip(), maxsplit=1)[0]
    boundaries = re.finditer(r'[.!?](?:["’”)]*)\s+(?=[A-Z“"])', text)
    sentences = 0
    for boundary in boundaries:
        if re.search(r"\b(?:[A-Z]|e\.g|i\.e|et al|Dr|No|Fig)\.$", text[:boundary.start() + 1]):
            continue
        sentences += 1
        if sentences == 2:
            return text[:boundary.end()].rstrip()
    return text


def definition_key(text):
    return hashlib.sha256(" ".join(first_two_sentences(text).split()).encode()).hexdigest()


def concept_overview(concept_id, definition, chpo_row, localization):
    if not definition:
        return {"kind": "unavailable", "text": "当前来源暂无可核对的" +
                ("表型定义。" if concept_id.startswith("HP:") else "疾病概述。")}
    presentation = wiki_overview(concept_id, definition)
    excerpt = TRANSLATED_EXCERPTS.get(concept_id)
    original = definition["original"]
    if presentation is None and excerpt and definition["entry_id"] == excerpt[0] and all(
        passage in original for passage in excerpt[1]
    ):
        presentation = {"kind": "translation", "text": excerpt[2]}
    if presentation is None and chpo_row and definition["source"] == "HPO":
        translated = usable_text(chpo_row["chinese_description"])
        if translated and original.split() == chpo_row["english_description"].split():
            presentation = {"kind": "translation", "text": first_two_sentences(translated, chinese=True),
                            "translation_url": CHPO_URL}
    if presentation is None:
        key = definition_key(original)
        translated = localization["definitions"].get(key, "")
        require(HAN.search(translated), f"Missing Chinese definition for {concept_id}")
        kind = "translation" if key in localization["curated_definitions"] else "machine_translation"
        presentation = {"kind": kind, "text": translated}
    return {**definition, **presentation}


def hpo_annotations(disease_ids, hpo_version):
    annotations = defaultdict(lambda: defaultdict(set))
    metadata = {}
    with gzip.open(HPO_ANNOTATIONS, "rt", encoding="utf-8", newline="") as source:
        for line in source:
            if not line.startswith("#"):
                break
            key, _, value = line[1:].partition(":")
            metadata[key] = value.strip()
        if f"/{hpo_version}/" not in metadata.get("hpo-version", ""):
            raise ValueError(f"HPO annotation release does not match {hpo_version}")
        for row in csv.DictReader(chain([line], source), delimiter="\t"):
            disease_id = row["database_id"]
            if disease_id not in disease_ids or row["aspect"] != "P" or row["qualifier"] == "NOT":
                continue
            if re.fullmatch(r"HP:0040285|0/[1-9]\d*|0(?:\.0+)?%", row["frequency"]):
                continue
            annotations[disease_id][row["hpo_id"]].update(filter(None, row["reference"].split(";")))
    return annotations, metadata["version"]


def descendants(roots, children):
    seen = set(roots)
    pending = list(roots)
    while pending:
        for child in children.get(pending.pop(), ()):
            if child not in seen:
                seen.add(child)
                pending.append(child)
    return seen


def read_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def json_lines(path):
    with path.open(encoding="utf-8") as source:
        yield from map(json.loads, source)


def normalized_records():
    for number, (row, mapping) in enumerate(
        zip_longest(json_lines(EVIDENCE), json_lines(DISEASE_NORMALIZATION)), 1
    ):
        if row is None or mapping != {key: row.get(key) for key in MAPPING_FIELDS}:
            raise ValueError(f"Disease normalization mismatch at line {number}")
        if not row["normalized_disease_id"]:
            raise ValueError(f"Missing disease ID at evidence line {number}")
        yield row


def relation_key(row):
    return "--".join(row[field] for field in ("hgnc_id", "normalized_disease_id", "inheritance_id"))


def preserve_omim_qualifiers(row):
    if row["source"] != "OMIM":
        return row
    phenotype = row["record"]
    if re.search(r"\bmodifier of\b", phenotype.get("phenotype") or "", re.I):
        row = {**row, "relationship_role": "modifier"}
    raw = phenotype.get("phenotypeInheritance") or ""
    declared = {mode.strip().lstrip("?").strip().casefold() for mode in raw.split(";")}
    if declared.issuperset(OMIM_MODES.values()):
        row = {**row, "inheritance_id": OMIM_AD_AND_AR, "inheritance_ids": list(OMIM_MODES),
               "inheritance_label": "Autosomal dominant; Autosomal recessive"}
    return row


def omim_adjustments(original, row):
    changes = {}
    if row.get("relationship_role") == "modifier" and original.get("relationship_role") != "modifier":
        changes.update(relationshipRole="modifier", sourceDiseaseLabel=row["source_disease_label"])
    if original["inheritance_id"] != row["inheritance_id"]:
        changes.update(inheritanceIds=row["inheritance_ids"], sourceInheritance=row["source_inheritance"],
                       newRelationshipKey=relation_key(row))
    if not changes:
        return None
    return {
        "source": row["source"], "recordId": row["source_record_id"],
        "rawPath": row["raw_path"], "rawLocator": row["raw_locator"], **changes,
    }


def source_field_example(row):
    record = {}
    if row["source"] == "NCBI/ClinVar":
        record["SourceName"] = row["record"].get("SourceName")
    if row["source"] == "PanelApp UK" and "Expert Review Removed" in (row["record"].get("evidence") or []):
        record["evidence"] = ["Expert Review Removed"]
    return {key: row[key] for key in ("source", "source_rating", "relationship_role")} | {
        "record": record
    }


def source_field_value(row):
    return row["record"].get("SourceName") if row["source"] == "NCBI/ClinVar" else row["source_rating"]


def rating_conflicts(rows):
    result = []
    for source in RATING_SOURCES:
        assessors = defaultdict(set)
        for row in rows:
            value = row["source_rating"]
            if row["source"] == source and row["assessor"] and value in (*RATING_TIERS, *CONTESTED_RATINGS):
                assessors[value].add(row["assessor"].strip().lower())
        support = [value for value in RATING_TIERS if assessors.get(value, set()) - {""}]
        contested = [value for value in CONTESTED_RATINGS if assessors.get(value, set()) - {""}]
        for kind, comparison, counts in (("conclusion", contested, support + contested),
                                         ("strength", support, support)):
            if any(a != b and len((assessors[a] | assessors[b]) - {""}) > 1
                   for a in support for b in comparison):
                result.append({"source": source, "kind": kind, "counts": [
                    {"value": value, "count": len(assessors[value] - {""})} for value in counts
                ]})
    return result


def relationship_summary(key, rows, moved_from):
    first = rows[0]
    example = next((row for row in rows if row["relationship_role"] == "modifier"), None)
    if example is None:
        example = next((row for tier in RATING_TIERS for row in rows
                        if row["source"] in RATING_SOURCES and row["source_rating"] == tier), None)
    if example is None:
        example = next((row for row in rows if source_field_value(row)), first)
    return {
        "entity_id": key, "inheritance_id": first["inheritance_id"], "inheritance_label": first["inheritance_label"],
        "evidence_count": len(rows), "rating": next((tier for tier in RATING_TIERS if any(
            row["source"] in RATING_SOURCES and row["source_rating"] == tier for row in rows
        )), None),
        "ratingConflicts": rating_conflicts(rows), "sources": list(dict.fromkeys(row["source"] for row in rows)),
        "example": source_field_example(example),
        **({"inheritance_ids": first["inheritance_ids"]} if "inheritance_ids" in first else {}),
        **({"previous_keys": sorted(moved_from[key])} if key in moved_from else {}),
    }


def write_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, separators=(",", ":")) + "\n", encoding="utf-8")


def gene_metadata():
    genes = read_json(NORMALIZED / "gene-metadata.json")
    members = {gene["hgnc_id"]: gene for gene in genes.values()}
    if len(members) != len(genes) or any(symbol != gene["symbol"] for symbol, gene in genes.items()):
        raise ValueError("Gene metadata contains mismatched symbols or duplicate HGNC IDs")
    return members


def clustered_evidence(include_search=False):
    grouped = defaultdict(list)
    original_counts = Counter()
    adjustments = defaultdict(list)
    moved_from = defaultdict(set)
    search = defaultdict(lambda: {"codes": set(), "names": set(), "labels": Counter()})
    guide = {}
    for original in normalized_records():
        old_key = relation_key(original)
        original_counts[old_key] += 1
        row = preserve_omim_qualifiers(original)
        key = relation_key(row)
        grouped[key].append(row)
        if old_key != key:
            moved_from[key].add(old_key)
        if change := omim_adjustments(original, row):
            adjustments[old_key].append(change)
        if include_search:
            fields = search[row["normalized_disease_id"]]
            record = row["record"]
            fields["codes"].update(filter(None, (row["source_disease_id"], record.get("disease_original_curie"),
                                                 record.get("submitted_as_disease_id"))))
            if record.get("DiseaseMIM"):
                fields["codes"].add(f"OMIM:{record['DiseaseMIM']}")
            if row["source_disease_label"]:
                fields["names"].add(row["source_disease_label"])
            if row["normalized_disease_label"]:
                fields["labels"][row["normalized_disease_label"]] += 1
            example = source_field_example(row)
            guide[json.dumps(example, sort_keys=True)] = example
    return grouped, original_counts, dict(adjustments), moved_from, search, list(guide.values())


def concept_pages(ids, branch_ids, search, mondo, hpo, versions, localization):
    terms = mondo | hpo
    children = defaultdict(list)
    for term_id, term in terms.items():
        if not term["obsolete"]:
            for parent in term["parents"]:
                children[parent].append(term_id)
    for hp, (disease, predicate) in FEATURE_BRANCHES.items():
        if (predicate, hp) not in terms[disease]["features"]:
            raise ValueError(f"Missing MONDO feature edge: {disease} {predicate} {hp}")
    branch_children = {parent: [child for child in children[parent] if child in branch_ids] for parent in branch_ids}
    with CHPO.open(encoding="utf-8-sig", newline="") as source:
        chpo = {row["hpo_id"]: row for row in csv.DictReader(source)}
    zh_hpo = {hp: usable_text(row["chinese_term"]) for hp, row in chpo.items()}
    exact_ids = exact_disease_ids(mondo)
    mapped_ids = clinical_disease_ids(mondo, exact_ids)
    annotation_ids = {concept_id: mapped_ids[concept_id] | {concept_id} for concept_id in ids}
    annotations, annotation_version = hpo_annotations(set().union(*annotation_ids.values()), versions["hpo"])
    versions["hpo_annotations"] = annotation_version
    mondo_by_omim = defaultdict(set)
    for mondo_id, equivalent_ids in exact_ids.items():
        for omim_id in filter(OMIM_ID.fullmatch, equivalent_ids):
            mondo_by_omim[omim_id].add(mondo_id)

    codes = defaultdict(set)
    for term_id, term in terms.items():
        target = term_id
        if term["obsolete"]:
            if len(term["replaced_by"]) != 1:
                continue
            target = term["replaced_by"][0]
        if target in ids:
            codes[target].update(term["xrefs"])

    def localized_name(term_id, title):
        curated, _ = LOCAL_TERMS.get(term_id, (None, []))
        if curated or zh_hpo.get(term_id):
            return curated or zh_hpo[term_id]
        key = " ".join(title.removeprefix("obsolete ").split())
        return localization["names"].get(key, "")

    def term_ref(term_id):
        english = terms[term_id]["title"]
        chinese = localized_name(term_id, english)
        return {"id": term_id, "title": chinese or english,
                **({"english_title": english} if chinese else {})}

    def clinical_features(concept_id, term):
        features = defaultdict(dict)
        for disease_id in sorted(annotation_ids[concept_id]):
            for hp, references in annotations.get(disease_id, {}).items():
                if hp in hpo:
                    features[hp].setdefault("hpo_annotations", []).append({
                        "disease_id": disease_id, "references": sorted(references),
                    })
        for predicate, hp in term.get("features", []):
            if hp in hpo:
                features[hp].setdefault("mondo_predicates", []).append(predicate)
        return [
            {"id": hp, "title": CLINICAL_FEATURE_ZH.get(hp) or term_ref(hp)["title"],
             "english_title": hpo[hp]["title"], "aliases": sorted(set(hpo[hp]["aliases"] + [zh_hpo.get(hp) or ""]) - {""}),
             **features[hp]}
            for hp in sorted(features)
        ]

    def definition_for(concept_id, term):
        definition = ontology_definition(concept_id, term, versions["hpo"] if concept_id in hpo else versions["mondo"])
        if definition:
            return definition
        candidates = {concept_id} if OMIM_ID.fullmatch(concept_id) else {
            omim_id for omim_id in exact_ids[concept_id] if mondo_by_omim[omim_id] == {concept_id}
        }
        descriptions = [definition for omim_id in sorted(candidates) if (definition := omim_definition(omim_id))]
        return descriptions[0] if len(descriptions) == 1 else localization["added_definitions"].get(concept_id)

    for concept_id in sorted(ids):
        term = terms.get(concept_id, {})
        fields = search[concept_id]
        fallback = fields["labels"].most_common(1)
        title = term.get("title") or (fallback[0][0].strip('"') if fallback else concept_id)
        aliases = LOCAL_TERMS.get(concept_id, (None, []))[1]
        if title == concept_id and concept_id in UNNAMED_TERMS:
            zh, title = UNNAMED_TERMS[concept_id]
        else:
            zh = localized_name(concept_id, title)
        require(HAN.search(zh), f"Missing Chinese name for {concept_id}: {title}")
        orpha = ORPHA_LABELS.get(concept_id)
        if orpha and orpha not in codes[concept_id]:
            raise ValueError(f"Missing Orphanet mapping: {concept_id} {orpha}")
        linked = FEATURE_BRANCHES.get(concept_id)
        ancestry = {concept_id}
        pending = [concept_id]
        while pending:
            for parent in terms.get(pending.pop(), {}).get("parents", []):
                if parent not in ancestry:
                    ancestry.add(parent)
                    pending.append(parent)
        features = [{**term_ref(hp), "predicate": predicate} for hp, (disease, predicate) in
                    FEATURE_BRANCHES.items() if disease in ancestry]
        scope = {concept_id, *([linked[0]] if linked else [])}
        if concept_id in branch_ids:
            scope = descendants(scope, branch_children)
        search_codes = (codes[concept_id] | fields["codes"]) - {concept_id}
        names = fields["names"] | set(aliases) | set(term.get("aliases", []))
        other_codes = {"ORPHA:" + code.split(":", 1)[1] for code in search_codes
                       if code.lower().startswith("orphanet:")}
        catalog = {
            "entity_id": concept_id, "title": title, "zh": zh,
            **({"obsolete": True, "replaced_by": term["replaced_by"], "merged": term["merged"]}
               if term.get("obsolete") else {}),
            "search_terms": sorted((search_codes | other_codes | names) - {concept_id, title, zh}),
        }
        detail = {
            "entity_id": concept_id, "search_codes": sorted(search_codes), "orpha_label_code": orpha,
            "parents": [term_ref(parent) for parent in term.get("parents", []) if parent in terms],
            "children": [term_ref(child) for child in sorted(children.get(concept_id, [])) if child in ids],
            "features": features, "clinical_features": clinical_features(concept_id, term),
            "overview": concept_overview(concept_id, definition_for(concept_id, term), chpo.get(concept_id), localization),
            "disease_branch": ({**term_ref(linked[0]), "predicate": linked[1]} if linked else None),
            "scope_ids": sorted(scope - {concept_id}),
        }
        yield catalog, detail


def legacy_version():
    with EVIDENCE.open("rb") as source:
        return f"full-5344@sha256:{hashlib.file_digest(source, 'sha256').hexdigest()}"


def build_files(directory):
    members = gene_metadata()
    grouped, _, adjustments, moved_from, search, guide = clustered_evidence(include_search=True)
    by_disease = defaultdict(lambda: defaultdict(list))
    by_gene = defaultdict(lambda: defaultdict(list))
    for kind in ("gene", "disease", "evidence"):
        (directory / kind).mkdir()
    for key, rows in grouped.items():
        gene_id, disease_id, _ = key.split("--")
        summary = relationship_summary(key, rows, moved_from)
        by_disease[disease_id][gene_id].append(summary)
        by_gene[gene_id][disease_id].append(summary)
        write_json(directory / "evidence" / f"{key}.json", rows)
    write_json(directory / "review-adjustments.json", adjustments)
    write_json(directory / "source-fields.json", guide)
    genes = []
    for gene_id, gene in sorted(members.items(), key=lambda item: item[1]["symbol"]):
        lookup = {key: gene[key] for key in ("hgnc_id", "symbol", "name", "omim_id", "alias_symbol", "prev_symbol") if key in gene}
        associations = by_gene[gene_id]
        genes.append({**lookup, "association_count": len(associations)})
        info = {key: gene[key] for key in ("location", "entrez_id", "ensembl_gene_id") if key in gene}
        write_json(directory / "gene" / f"{gene_id}.json",
                   {"hgnc_id": gene_id, "info": info, "associations": list(associations.items())})
    mondo, mondo_version = ontology(MONDO, "MONDO")
    hpo, hpo_version = ontology(HPO, "HP")
    terms = mondo | hpo
    children = defaultdict(list)
    for term_id, term in terms.items():
        if not term["obsolete"]:
            for parent in term["parents"]:
                children[parent].append(term_id)
    # Keep the established example scopes and the existing routes into their ontology branches.
    branch_ids = descendants(BRANCH_ROOTS | {disease for disease, _ in FEATURE_BRANCHES.values()}, children)
    ids = set(by_disease) | branch_ids
    pending = list(ids)
    while pending:
        for replacement in terms.get(pending.pop(), {}).get("replaced_by", []):
            if replacement in terms and replacement not in ids:
                ids.add(replacement)
                pending.append(replacement)
    versions = {"mondo": mondo_version, "hpo": hpo_version}
    diseases = []
    localization = read_json(ZH_CATALOG)
    for concept, detail in concept_pages(ids, branch_ids, search, mondo, hpo, versions, localization):
        disease_id = concept["entity_id"]
        diseases.append(concept)
        genes_with_evidence = [
            [gene_id, members[gene_id].get("location"), summaries]
            for gene_id, summaries in by_disease[disease_id].items()
        ]
        write_json(directory / "disease" / f"{disease_id}.json", {**detail, "genes": genes_with_evidence})
    version = legacy_version()
    return {"diseases": diseases, "genes": genes, "input_version": version,
            "knowledge_base_version": f"{version}+omim-qualifiers.1", "ontology_versions": versions}


def require(condition, message):
    if not condition:
        raise ValueError(message)


def file_ids(directory):
    return {path.stem for path in directory.glob("*.json")}


def verify(catalog, directory):
    grouped, original, adjustments, moved_from, _, _ = clustered_evidence()
    members = gene_metadata()
    report = read_json(NORMALIZED / "compile-report.json")
    expected_gene_ids = set(members)
    expected_disease_ids = {key.split("--")[1] for key in original}
    record_count = sum(original.values())
    with (NORMALIZED / "unresolved-evidence.jsonl").open("rb") as source:
        unresolved_count = sum(1 for line in source if line.strip())
    require((len(members), len(expected_disease_ids), len(original), record_count, unresolved_count) ==
            (report["pages"]["genes"], report["pages"]["diseases"], report["pages"]["relationships"],
             report["assertions"], report["unresolved_evidence"]), "Inputs differ from compile-report totals")
    require(catalog["input_version"] == legacy_version(), "Export is from different normalized evidence")
    require(file_ids(directory / "evidence") == grouped.keys(), "Evidence file keys differ")
    require(read_json(directory / "review-adjustments.json") == adjustments, "Review adjustments differ")
    summaries = {}
    genes_by_disease = defaultdict(set)
    for key, expected in grouped.items():
        actual = read_json(directory / "evidence" / f"{key}.json")
        require(actual == expected, f"Source records differ for {key}")
        identities = [json.dumps([row["source"], row["source_record_id"], row["raw_path"], row["raw_locator"]],
                                 sort_keys=True) for row in actual]
        require(len(set(identities)) == len(actual), f"Duplicate source record within relation {key}")
        summaries[key] = relationship_summary(key, expected, moved_from)
        gene_id, disease_id, _ = key.split("--")
        genes_by_disease[gene_id].add(disease_id)

    genes = {gene["hgnc_id"]: gene for gene in catalog["genes"]}
    diseases = {row["entity_id"] for row in catalog["diseases"]}
    require(len(genes) == len(catalog["genes"]) and set(genes) == expected_gene_ids ==
            file_ids(directory / "gene"), "Catalog or gene detail IDs differ from HGNC metadata")
    require(len(diseases) == len(catalog["diseases"]) and expected_disease_ids <= diseases ==
            file_ids(directory / "disease"), "Catalog or disease detail IDs differ from normalized IDs")
    for gene_id, gene in genes.items():
        require(gene["symbol"] == members[gene_id]["symbol"] and
                gene["association_count"] == len(genes_by_disease.get(gene_id, ())),
                f"Catalog symbol or association count differs for {gene_id}")

    localization_counts = Counter()
    for disease in catalog["diseases"]:
        require(disease["title"] and HAN.search(disease["zh"]), f"Missing bilingual name for {disease['entity_id']}")

    def verify_direction(kind, ids, field):
        found = set()
        for entity_id in ids:
            page = read_json(directory / kind / f"{entity_id}.json")
            id_field = "hgnc_id" if kind == "gene" else "entity_id"
            require(page[id_field] == entity_id, f"Wrong detail ID for {entity_id}")
            if kind == "disease":
                overview = page["overview"]
                require(HAN.search(overview["text"]) and overview["kind"] != "original",
                        f"Missing Chinese overview text for {entity_id}")
                localization_counts[overview["kind"]] += 1
            peers = set()
            for peer, *_, relations in page[field]:
                require(peer not in peers and relations, f"Duplicate or empty association under {entity_id}")
                peers.add(peer)
                gene_id, disease_id = (entity_id, peer) if kind == "gene" else (peer, entity_id)
                for summary in relations:
                    key = "--".join((gene_id, disease_id, summary["inheritance_id"]))
                    require(key not in found and summary == summaries.get(key), f"Wrong {kind} relation {key}")
                    found.add(key)
        require(found == summaries.keys(), f"{kind} direction differs from normalized relationships")

    verify_direction("gene", genes, "associations")
    verify_direction("disease", diseases, "genes")
    new_keys = grouped.keys() - original.keys()
    removed_keys = original.keys() - grouped.keys()
    rekeyed_rows = sum("newRelationshipKey" in change for changes in adjustments.values() for change in changes)
    return {
        "genes": len(genes), "genes_with_associations": len(genes_by_disease),
        "genes_without_associations": len(genes) - len(genes_by_disease),
        "normalized_disease_ids": len(expected_disease_ids), "additional_ontology_pages": len(diseases - expected_disease_ids),
        "source_records": record_count, "unresolved_source_records": unresolved_count,
        "normalized_relationship_keys": len(original), "exported_relationship_keys": len(grouped),
        "localization": {"bilingual_names": len(diseases), "overview_status": dict(sorted(localization_counts.items()))},
        "omim_relationship_change": {
            "source_records_rekeyed": rekeyed_rows, "combined_ad_ar_keys": len(new_keys),
            "previous_keys_emptied": len(removed_keys), "previous_keys_retaining_records": len(
                set().union(*moved_from.values()) & grouped.keys()
            ),
            "modifier_source_records": sum(row["relationship_role"] == "modifier"
                                           for rows in grouped.values() for row in rows),
        },
        "verified": ["HGNC IDs and symbols", "disease IDs and normalization rows", "all source records",
                     "identical relationship keys and summaries in both directions"],
    }


def export():
    with TemporaryDirectory(prefix=".peaindex-", dir=ROOT) as temporary:
        stage = Path(temporary)
        directory = stage / "data"
        directory.mkdir()
        catalog = build_files(directory)
        report = verify(catalog, directory)
        write_json(directory / "build-report.json", report)
        # Publish the data before switching the catalog. Open tabs can finish using their original data.
        digest = hashlib.sha256()
        for path in sorted(directory.rglob("*.json")):
            digest.update(path.relative_to(directory).as_posix().encode())
            digest.update(hashlib.sha256(path.read_bytes()).digest())
        generation = digest.hexdigest()[:20]
        destination = DATA_ROOT / "library" / generation
        destination.parent.mkdir(parents=True, exist_ok=True)
        try:
            directory.rename(destination)
        except OSError:
            if not destination.is_dir():
                raise
            verify(catalog, destination)
        catalog["generation"] = generation
        catalog_path = stage / "catalog.json"
        write_json(catalog_path, catalog)
        compressed_path = stage / "catalog.json.gz"
        compressed_path.write_bytes(gzip.compress(catalog_path.read_bytes(), mtime=0))
        DATA_ROOT.mkdir(parents=True, exist_ok=True)
        catalog_path.replace(DATA_ROOT / "catalog.json")
        compressed_path.replace(DATA_ROOT / "catalog.json.gz")
        return report


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--verify", action="store_true", help="Reconcile the already published full export.")
    if parser.parse_args().verify:
        existing = read_json(DATA_ROOT / "catalog.json")
        require(existing == json.loads(gzip.decompress((DATA_ROOT / "catalog.json.gz").read_bytes())),
                "Browser catalog differs from the uncompressed catalog")
        result = verify(existing, DATA_ROOT / "library" / existing["generation"])
    else:
        result = export()
    print(json.dumps(result, indent=2, ensure_ascii=False))
