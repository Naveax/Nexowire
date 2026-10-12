# Nexowire AI çalışma alanı | Runbook varsayılan hedefi

## Düzeltilen boşluk

`NEXOWIRE_AI_UI_TARGET_DEFAULT=private_desktop` ayarı #411 kapsamında
`shell.exec`, `process.start`, `task.graph.run`, `workspace.checks`
ve tarayıcı oturumlarına uygulanıyordu. Ancak üst düzey
`runbook.run` ayrı bir `headless` varsayılanı içerdiğinden,
AI bir runbook çağrısı sırasında `ui_target` belirtmezse
bağımlı komut görevleri kullanıcının görünür masaüstüne
uygunsuz süreçler başlatabilecek standart yola dönebiliyordu.

## Kaynak kodu değişikliği

- Runbook girişindeki `ui_target` artık isteğe bağlıdır.
  `resolveAiWorkspaceTarget` ile sahibi tarafından ayarlanan
  varsayılan hedef hesaplanır.
- Hesaplanan özel masaüstü hedefi her iç `task_graph` adımına
  uygulanır. İç plan açıkça `headless` seçse bile
  özel runbook'un alt adımı bu sınırı düşüremez.
- **Runbook checkpoint özeti ve hash'i** çözülmüş hedefi
  kullanır. Böylece kullanıcı `private_desktop` ile başladığı
  bir runbook'u sonradan `headless` varsayılanı altında
  sessizce devam ettiremez. Eski/başlangıç
  `headless` hash davranışı korunur.
- API isteğinde açıkça `ui_target:headless` verilirse
  kullanıcının kasıtlı tercihi genel varsayılanı geçersiz kılar.
  Bu nedenle özel masaüstü henüz **zorunlu güvenlik politikası**
  değildir; istenirse ayrı sahip onaylı katı politika gerekir.

## DEV doğrulaması

Windows DEV canlı testinde `NEXOWIRE_AI_UI_TARGET_DEFAULT=private_desktop`
açıkken `runbook.run` çağrısından `ui_target` çıkarıldı.
İki bağımlı PowerShell görev grafiği ayrı `NexowirePrivate`
masaüstünde tamamlandı ve `inputDesktop=Default` korundu.
Runbook'un içinden `ui_target:headless` geçirme denemesi
üst düzey özel hedefi aşamadı. Ayrı birim testleri
eski headless moduna uyumluluğu, açık headless
önceliğini ve checkpoint hash uyumsuzluğu reddini sınadı.

## Sınırlar

Bütün uygulama başlatma yolları, Windows Explorer/COM
aracılığıyla pencere açma, sistem izin pencereleri ve
çok uzun süreli odak koruma henüz tam doğrulanmış değildir.
Bu değişiklik üretime dağıtılmadı; #402 AI UX ve
#271 korunmuş üretim çalışma zamanı açık.
