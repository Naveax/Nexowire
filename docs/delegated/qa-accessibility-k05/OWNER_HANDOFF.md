# K05 → UI sahipleri: erişilebilirlik QA devri

Tarih: 2026-11-01 (Europe/Istanbul) — P002 snapshot; kaynak `Naveax/main` `93b6df33ef58610dcfdf3584bfe774e5afa7df4d`.

K05 yalnız `scripts/delegated/k05/**`, `test/delegated/k05/**` ve `docs/delegated/qa-accessibility-k05/**` değiştirdi. Aşağıdaki kaynak dosyalarının hiçbirine dokunulmadı.

| Sahip | Kaynak ve sorun/kanıt | İstenen inceleme | Kabul sınırı |
| --- | --- | --- | --- |
| K01 | `web/connect.html`, `#install-content` `aria-live=polite` altında `#copy-status` `role=status`; `nested-live-region` | Çift anons riski için tek bildirim semantiği seç; [K01 PR #1011](https://github.com/Naveax/Nexowire/pull/1011) ile çakışmayı denetle; P002 T-141 uygun | Gerçek ekran okuyucu kabulü NOT_RUN; kaynak bulgusu otomatik |
| K04 | `web/admin.html:32`, `#admin-error` canlı hata rolü yok; `silent-error-panel` | P002 T-154 kapsamında `role=alert`/uygun canlı bildirim seç; [K04 PR #1015](https://github.com/Naveax/Nexowire/pull/1015) etkisini kontrol et | Gerçek hata anonsu NOT_RUN; yalnız statik kusur kanıtı |
| K02 | `web/styles.css` bazı hedeflerde `min-height:36px`/`39px` | P002 T-145/T-148 mobil CSS, aralık/ölçü, zoom; [K02 PR #1010](https://github.com/Naveax/Nexowire/pull/1010) ve [#1012](https://github.com/Naveax/Nexowire/pull/1012) ile uyum | Boyut tek başına ihlal kanıtı değil; dokunmatik test NOT_RUN |
| K03 | `web/app.js`, cihaz kartı `pcPanel.id = 'pc-settings-' + devices.indexOf(device)` ve `aria-controls` | P002 T-152 ile tekrar eden cihaz/kimlik senaryosunu gerçek render DOM'da ölç | Sentetik iki kart ID testi PASS; gerçek JS/keyboard NOT_RUN |
| K13 | K05 `.mjs` runner'ları genel `.test.ts` globuna girmiyor | Fork CI'da salt-okunur, ağsız bağımsız job veya explicit Node komutu; owner workflow'u dışında K05 yazmaz | Upstream `action_required`, jobs 0; CI PASS ilan edilmez |

## Yeniden üretim

```sh
node test/delegated/k05/audit-html.test.mjs
node test/delegated/k05/dynamic-id-contract.test.mjs
node scripts/delegated/k05/audit-html.mjs
```

İlk iki komut bağımsız QA testidir. Sonuncusu kaynak bulgularını listeler ve **mevcut upstream kaynakta 2 bulgu nedeniyle exit 1** verir. Bulguları saklamak için waiver eklenmemiştir. Statik kaynak PASS, gerçek erişilebilirlik kabulü değildir.
