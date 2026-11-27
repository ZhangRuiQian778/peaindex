# 豌豆索引 PeaIndex｜基因–疾病证据复核台

应用壳和发布数据分开构建。数据发布目录为 `external-data/`，应用构建目录为 `dist/`。页面入口见 [本地复核台](http://127.0.0.1:4173/)。

```sh
# 生成或更新 external-data/catalog.json、catalog.json.gz 和版本分片
python3 export_demo_slice.py
# 单独核对已发布目录
python3 export_demo_slice.py --verify
# 构建只含 HTML、JS、CSS 的静态应用壳
npm run build
# 启动默认的本地应用和 /data/* 数据映射
npm run dev
```

`npm start` 与 `npm run dev` 使用 `127.0.0.1:4173`。可通过 `npm run dev -- --port 4174` 启动另一个端口。开发服务器只暴露 `dist/` 中的三个应用文件和 `external-data/` 中的发布文件，并拒绝越界路径。已有本地导出时，断开外网仍可检索和复核。

## 应用构建和数据域名

`npm run build` 不读取 `external-data/`、原始 `data/` 或本体输入，生成 `dist/index.html`、`dist/app.js` 和 `dist/styles.css`，并报告文件数和总大小。当前壳约 110 KiB。构建时通过环境变量或根目录 `.env` 设置公开数据 URL：

```sh
PEAINDEX_DATA_BASE_URL=https://data.example.com/peaindex/ npm run build
```

可从 [.env.example](.env.example) 复制本地配置。进程环境变量优先于 `.env`，空值表示使用同源 `/data/`。配置值会按 URL 根解析，因此带或不带尾斜杠都指向 `catalog.json.gz`。浏览器统一通过 `resolveDataUrl()` 请求目录、`library/<generation>/` 分片、`gene/`、`disease/`、`evidence/`、`source-fields.json` 和 `review-adjustments.json`。压缩目录请求、解压或解析失败时自动回退 `catalog.json`。

- 输入 `高胆固醇血症`、`家族性高胆固醇`、`FH`、`Orphanet:558` 或疾病英文名。检索支持一个字符的增删、替换或相邻对调。
- 打开 `HP:0010980` 后可切换当前表型与关联疾病分支。合并视图按 HGNC ID 去重，展开同一基因可按原始疾病或表型分别复核。
- 输入 `LDLR` 或 `FBN1` 进入基因视图，查看本地 `full-5344` 中该基因的所有标准化关系。疾病页和基因页读取相同的复核决定。
- 在证据抽屉按关系键保存结论、理由及引用。采信需勾选至少一条来源记录。复核保存在当前浏览器的本地存储，刷新后可恢复。采信快照默认使用当前视图，可切换至此浏览器全部采信。JSON 和表格均保留原始文件、定位信息、复核时间和知识库版本。
- 打开 `MONDO:0010975`，选择「评级有分歧」，再点 RYR2 的「比较原始评级」。筛选检查同一关系键、同一评级体系内不同提交方的评级差异。

## 数据范围与来源

目录和详情页为疾病及表型提供中英文名称，检索支持两种名称。表型定义和疾病概述显示中文，并保留来源编号、版本和链接。没有可核对定义的条目会显示中文提示。

详情页优先使用当前编号对应的 MONDO 或 HPO 定义，也使用能通过精确映射确认的本地 OMIM 描述、Orphanet 4.9 或 MedGen 2026-11-24 摘录。中文词表和摘译保存在 `data/full-5344/localization/zh-CN.json`。批量译文在页面标为「机器翻译」，已有中文术语和已核对的摘译优先使用。全量构建直接读取本地词表，不调用翻译服务。[Orphanet 罕见病本体](https://www.orphadata.com/ordo/) · [NCBI MedGen](https://www.ncbi.nlm.nih.gov/medgen/)

全量版使用 `data/full-5344/normalized/` 的基因元数据、规范化证据、疾病映射和编译报告。首页读取压缩检索目录。实体页按需读取双向关系摘要，打开遗传方式分组再读取该关系的原始证据。发布文件位于 `external-data/library/` 下的版本目录，逐关系对账结果见同目录中的 `build-report.json`。未解析记录保存在 `data/full-5344/normalized/unresolved-evidence.jsonl`。旧 generation 会保留在 `external-data/library/`，打开中的页面继续使用其目录声明的 generation。

## 对象存储同步

`cors.json` 提供 Cloudflare R2 的 CORS 示例，正式部署时把 `https://peaindex.example.com` 换成实际前端 Origin。允许的方法为 `GET` 和 `HEAD`。阿里云 OSS 控制台中建立相同的规则，将允许来源填为正式前端域名，并按需加入 `http://127.0.0.1:4173` 和 `http://localhost:4173` 作为本地调试来源。

同步脚本使用 rclone。第一个参数为已配置的 `远端名:桶名`，桶需要事先创建。第二个参数为桶内前缀，传入 `""` 可发布到桶根目录。脚本先核对两份目录解压后的字节是否一致，再上传当前 generation，成功后更新两份可切换的目录。

```sh
bash scripts/sync-data.sh --dry-run r2:peaindex-data peaindex
bash scripts/sync-data.sh r2:peaindex-data peaindex
```

Cloudflare Pages 可从 GitHub 的 `main` 分支发布。构建命令填写 `npm run build`，输出目录填写 `dist`。在生产环境变量中设置 `PEAINDEX_DATA_BASE_URL`，值为 R2 自定义域和上面选定的对象前缀，例如 `https://data.example.com/peaindex/`。R2 CORS 的正式 Origin 填写部署后的 Pages 域名。

同步使用 `--transfers 32`。版本分片使用 `application/json` 和 `Cache-Control: public, max-age=31536000, immutable`。`catalog.json` 使用 `application/json` 和 `Cache-Control: no-cache`。`catalog.json.gz` 使用 `application/gzip`、`Cache-Control: no-cache`，并留空 `Content-Encoding`，由浏览器代码解压一次。将示例域名和 generation 替换为实际值，再查看 CDN 或对象存储的响应头。

```sh
rclone size r2:peaindex-data/peaindex/library/4e66d36ebfec5a7eefff
curl -fsSI -H 'Origin: https://peaindex.example.com' https://data.example.com/peaindex/catalog.json.gz
curl -fsSI -H 'Origin: https://peaindex.example.com' https://data.example.com/peaindex/catalog.json
curl -fsSI -H 'Origin: https://peaindex.example.com' https://data.example.com/peaindex/library/4e66d36ebfec5a7eefff/gene/HGNC%3A654.json
```

检查 `Access-Control-Allow-Origin` 是否匹配请求 Origin，并核对上面的类型和缓存策略。发布前归档上一版 `catalog.json` 和 `catalog.json.gz`。回滚时将归档的同一对文件恢复到 `external-data/`，再运行相同的同步命令。脚本会核对旧目录引用的 generation 并切换目录，依赖各自 generation 的页面能继续读到分片。

疾病层级使用 MONDO 和 HPO 的 `is_a`，表型与疾病分支沿用 MONDO 的已验证表型关系。补充的本体页面用于既有分支和历史编号跳转。

运行 `python3 batches/full-5344/compile_full.py --cached-mondo` 可用已校验的本地映射重新编译规范化输入。PanelApp 的单／双等位声明归入 `MONOALLELIC_AND_BIALLELIC`。导出时，OMIM 的 AD 和 AR 声明归入同一个关系键，原文和修饰因子限定随记录保留。涉及变更关系键的旧决定仍可查看原始引用，并标记待重新确认。知识库版本记录规范化证据的 SHA-256 和 OMIM 处理版本。

- MONDO 版本 `2026-11-03`，文件 `data/full-5344/staging/mondo/mondo-base.obo`。[MONDO 发布页](https://github.com/monarch-initiative/mondo/releases/tag/v2026-11-03)
- HPO 术语版本 `2026-09-01`，疾病表型注释版本 `2026-09-02`。本地分别保存为 `data/full-5344/staging/terminology/hp.obo` 和 `data/full-5344/staging/terminology/phenotype.hpoa.gz`。疾病页按 MONDO 精确映射匹配 HPO 注释，与当前疾病直接关联的 MONDO 表型按 HPO 编号合并展示。[HPO 发布页](https://github.com/obophenotype/human-phenotype-ontology/releases/tag/v2026-09-01)
- 中文表型词使用 PhenoCHPO 的公开 CHPO 镜像，文件 `data/full-5344/staging/terminology/chpo.csv`，SHA-256 为 `ded43d1b619a067e40fff131347817e2567a7638878efcf591b3a1a428d38b51`。[CHPO 镜像](https://github.com/pzweuj/PhenoCHPO/blob/main/data/chpo_dict.csv)
- Orphanet 编号和疾病映射取自 MONDO。对应中文病名与临床简称使用 `export_demo_slice.py` 内的本地词表。Orphanet 公开术语包列出的九种发布语言包括英语、法语和西班牙语，中文病名在页面标记为本地词表。[Orphanet 公开术语包](https://www.orphadata.com/_pack-nomenclature/)
