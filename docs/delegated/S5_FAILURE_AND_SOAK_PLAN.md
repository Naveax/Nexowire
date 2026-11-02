# S5-04 — Failure, soak ve sınır kabul planı

31 Ekim 2026 | Base main `a19a228dc6f19fd484cf935e941a00ea625233f8` | Dal `docs/delegated-s4-s5-20261031`
Kanıt türü: source-only / dokümantasyon; fiziksel veya üretim kabulü değildir.

## Kaynaklar

Tüm kaynaklar base SHA üzerindedir: [Free-only](../FREE_ONLY_POLICY.md), [S2/S4 teklif](../SCALE_V2_S2_S4_QUOTA_SUBSCRIPTION_STAGING.md), [checkout gate](../SCALE_V2_S4_CUSTOM_USAGE_CHECKOUT_GATE.md), [S5 kabul sınırları](../SCALE_V2_S5_LOAD_COST_ACCEPTANCE_20261018.md). İlgili işler: #486, #487. Canlı endpoint sorgulanmadı.

Tüm satırlar **NOT RUN**. Sentetik model, staging ve fiziksel kabul ayrı tutulur. Bu çalışma yük üretmez.

| Senaryo | İzin / yöntem | Beklenen güvenli sonuç | Kanıt metriği | Durum |
|---|---|---|---|---|
| D1 contention | Sentetik lock/timeout modeli; sonraki ayrı staging izni | Kısmi debit/dispatch yok | Conflict, deny, commit unknown | NOT RUN |
| Quota hard stop | Sentetik sınıra bir kala / eşzamanlı deneme | Limit aşılmaz; dispatch öncesi red | Reserved/denied/debit | NOT RUN |
| Relay outage | Sentetik kesik stream; staging ayrı izin | Bütçe aşılmaz; unknown terminal | Byte ledger, pending, hata | NOT RUN |
| Token rotation | Sentetik expired grant; gerçek auth dokunulmaz | Eski epoch kabul edilmez | Revision ve denied | NOT RUN |
| DNS loss | Sentetik hata enjeksiyonu; gerçek DNS değiştirilmez | Bounded failure; mutation replay yok | Hata, timeout, queue | NOT RUN |
| Wrong owner | Sentetik A/B kimlik | Victim hak/kota değişmez | Denied ve sıfır yan etki | NOT RUN |
| 409 replay | Sentetik aynı ID ve farklı fingerprint | İkinci execution yok; conflict korunur | Execution/debit sayısı | NOT RUN |
| Reconnect storm | Planlanan lab; socket açmak ayrı izin | Bounded queue/backoff; çift mutation yok | p99, queue, drops | NOT RUN |
| Stalled job | Sentetik heartbeat/ACK kaybı | Unknown terminal; otomatik tekrar yok | Terminal state, süre | NOT RUN |
| Cloud bill boundary | Sentetik eksik meter/fiyat; staging provider ayrıca izin | UNKNOWN; postpaid fallback yok | Meter kapsamı, alarm, spend | NOT RUN |
| 24h soak | Yetkili ayrı staging ve bütçe izni gerekli | Kesintisiz kayıt; bağımsız audit | 1440+ minute, gerçek completion, CPU/RSS, provider | NOT RUN |
| Foreground mouse | Atılabilir fiziksel lab ve açık cihaz izni gerekli | Kullanıcının foreground etkisi ayrı doğrulanır | Foreground etkisi ve owner observation | NOT RUN |

## Gelecekteki test kaydı

Her test: ID, #487 kaynak issue, branch ve exact SHA, komut, OS, UTC başlangıç/bitiş, beklenen/gözlenen, örnek hacmi, birimler, sentetik/yerel/staging/fiziksel tür, CI run ID, izin referansı ve engel taşır. Kanıt yoksa UNKNOWN/NOT RUN yazılır.

Ana ekip önceden bütçe, SLO, durdurma ve rollback owner belirlemelidir. Beklenmeyen ücret, yetkisiz dispatch, çift mutation, tenant sızıntısı, sayaç ayrışması veya kullanıcı etkisinde test durur; kanıt korunur. Bu belge servis/ayar değiştirme veya rollback çalıştırma yetkisi vermez.

24h metadata gate yalnız biçim doğrular; bağımsız provider ve completion kanıtını ikame etmez. Günlük yeniden oluşturulan yerel DB ile 24 saat sampler gerçek sürekli soak sayılmaz. p95/p99 eşiği ana ekip onayı bekler; kapasite, güvenlik veya release PASS verilmez.
