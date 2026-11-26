# P009 K15 Q-225…Q-230 — cihaz kimliği, geç hata ve CI teslim denetimi

Tarih: 2026-11-15 (Europe/Istanbul). İlgili issues: #539/R11, #485, #812, #1006. Kapsam yalnız mevcut [#1110](https://github.com/Naveax/Nexowire/pull/1110) test/docs yolu; owner production kaynaklarına dokunulmadı.

## Q-225: #1068 provenance / üç açık TODO

- Upstream main ref `52d452f717d891eeaf4c2b9aff3c6e1ea68369b0`, P009 bazından `main` karşılaştırması **identical, 0 ahead**.
- #1068 owner UI `94d38799e9e4b50fe84f7924e6fc84f90aeba090`, **Draft/open, unmerged**.
- Dört source UI Draft: #1010 `3f6a226e...`, #1011 `6e740dfe...`, #1015 `2d448f69...`, #1016 `96fa340b...`. Her 15 source file için GitHub exact blob SHA'ları owner #1068 ref'iyle **yeniden alındı**: **12/15 EXACT, 3/15 EVOLVED**.
- Üç evolved path:
  - `test/delegated/k02/responsive-css.test.ts` source blob `e5a635fac5ef290d32df646537c470a9d9cb57c3` -> owner `b4377a812cb2702aec4457c46d6c962d24f02bfe`.
  - `test/delegated/k03/panel-states.test.mjs` source blob `d3ca48fa3022c161945138180b45dfb0a505a1e2` -> owner `60d0d92c2bb53295013811028a708c64c1e44b70`.
  - `web/app.js` source blob `53f2d90a474ad7fa2626b74bf7062e8f8325e4c6` -> owner `ab5b5d186ee6e1e3dab074952ffcadb153d6ef31`.
- Önceden doğrulanmış owner-source VM negatifleri: **3 beklenen TODO** (403 permission-denied metni, sıfır cihazda `Bağlı` pill, sıralama ile değişen accessible ordinal). **403→fresh 200/zero devices owner adayı** daha önce VM'de PASS iken upstream main TODO idi. Bu adımda bu testler **tekrar koşturulmadı**; önceki PASS bu adımın PASS'i sayılmaz. Main `web/app.js` ve owner `web/app.js` zaten aynı değildir, ana dal kabulü yok.

## Q-226 / Q-229: PR ve owner path kapsamı

- #1110 bu adım başında `b7b1fe2c75275e98329ce6f24fe9a874427a7df7` (7 changed paths); #1068 18 changed paths. Exact path kesişimi **0**.
- Ömer'in yeni #1160 Draft entegrasyonu, kontrol anında `3d344177c82d26ab67a419e0bc1cbbe166443128` (126 changed paths). Değişen dosyalar listesinde **hiçbir `test/delegated/k15/**` veya `docs/delegated/device-ux-k15/**` dosyası yok**; #1110 ile direct path kesişimi **0**. #1160 `package.json` ve `.github/workflows/ci.yml` dosyalarını değiştiriyor, bunlar workflow sahibi Ömer'in alanı. #1160 henüz main'e girmedi; #1110 otomatik kabul sayılmaz.
- Eski dört UI source PR'ının source kodunu yeniden yazma / owner ref'ini ezme / bağımsız merge yok.

## Q-227: yeni, bağımsız negatif test (gerçek kod teslimi)

Mevcut `test/delegated/k15/issue-539-device-ux.test.mjs` dosyasına **Q-227** eklendi:

> İki eşzamanlı dashboard `load()` çağrısından daha yenisi 200 ile `fresh-machine` listesi getirirse, daha eski olanın gecikmiş HTTP 503 hatası güncel `Bağlı` pill'ini ve kapanmış error panelini geri bozamaz.

Bu, daha önceki **geç 200 → güncel 401** ve **geç 200 → yeni 200/folder** negatiflerinden farklı hata yönüdür; eski hata yeniyi bozamamalı. Test gerçek `web/app.js` yükleme fonksiyonunu kullanan mevcut sentetik DOM harness'ına eklenmiştir, production dosyası değiştirilmedi.

- Kod dalı commit: `2d1a7b3731cb0e319b256990cc4f046734ce4ff1`, test blob `e1a1d387f814913d2658ae20fbc55ef1d57f21ec`.
- Yeni test bloğunun **yalnız sözdizimi** `node --check` ile Node v22.16.0 ortamında kontrol edildi: exit 0. Bu, kaynak VM testinin PASS'i değildir.
- **Kaynak karşılaştırmasından beklenen**: main kodunda request-fence yok, test `TODO` olarak sınıflanmalı; #1068 owner `latestDashboardLoadId` ile geç cevabı bastırır, test adayda PASS hedeflemektedir. **Gerçek koşum: NOT_RUN; beklenti, ölçülen sonuç değildir.**
- CI workflow'a / owner code'a / auth/CORE'a değişiklik yapılmadı. K15 nested testleri CI'da çağrılana kadar otomatik hosted PASS iddiası yok.

## Q-228: önceki exact SHA CI — gerçek job log kanıtı

- Önceki docs-only exact SHA `b7b1fe2c75275e98329ce6f24fe9a874427a7df7` [run 43285593424](https://github.com/Naveax/Nexowire/actions/runs/43285593424): **completed/success, 7/7 gerçek job**.
- Node24 job `131418055742`, Node22 `131418055931`, browser-live `131418055657`: üç **ham log** okundu. K15 `issue-539-device-ux.test.mjs`, `target-versus-permission-matrix.test.mjs`, `chromium-device-ux.test.mjs` için hiçbir explicit callsite veya log eşleşmesi yok. Testler bu otomatik CI içinde **HOSTED NOT_RUN**.
- Yeni kod SHA `2d1a7b3731cb0e319b256990cc4f046734ce4ff1` otomatik [run 43751058906](https://github.com/Naveax/Nexowire/actions/runs/43751058906) ilk kontrol anında **queued**, `NOT_PASS`. Tekrar dispatch yapılmadı.
- Node22/24 `npm test` `node --test --import tsx test/**/*.test.ts` olduğundan nested K15 `.mjs` test dosyaları genel gate'de seçilmiyor. Gerekli explicit çağrıları yalnız K13/Ömer CI owner'ı yapmalı.

## Q-230: ayrık fiziksel kabul ve owner talepleri

- **Bu adım kanıtı:** gerçek GitHub blob karşılaştırması 15/15, iki PR'ın değişen dosya listeleri, exact-hosted workflow/log denetimi, test dosyasına WIP QA commit, yeni test bloğunda JS syntax exit0.
- **NOT_RUN:** yeni VM testinin main ve #1068 Node22/24 koşumu; gerçek Chromium 375px/screenshot/keyboard/screen-reader (önceki EPERM SKIP); Windows native grant, fiziksel pairing/kimlik/konsol, iki-PC, owner ana dal kabulü.
- Owner #1068: üç bilinen TODO'yu giderirken `latestDashboardLoadId` fence'i ve 403→200 privacy reset'i **koru**; eklenen 503-eski→200-yeni yarış testini çalıştır.
- K13 / Ömer #1096: K15 üç nested dosyanın exact SHA üzerinde Node22/24 workflow çağrısını ve TAP sonuçlarını sun; genel 7/7 yerine dosya çağrısı ile doğrula.
- ŞEF: mevcut Draft [#1110](https://github.com/Naveax/Nexowire/pull/1110) ile izle, yeni PR/merge/issue close yok. Issue #539/#485/#812/#1006 kabulü açık.
