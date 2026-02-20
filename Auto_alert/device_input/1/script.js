const video = document.getElementById('video');
const alertOverlay = document.getElementById('alertOverlay');
const canvas = document.getElementById('canvas');
const status = document.getElementById('status');
const registerNoMaskBtn = document.getElementById('registerNoMask');
const registerMaskBtn = document.getElementById('registerMask');
const startMonitorBtn = document.getElementById('startMonitor');

let faceMatcher = null;
let monitoring = false;
let alertAudio = new Audio('alert.mp3');
alertAudio.preload = 'auto'; // 事前読み込みで遅延減
let consecutiveNoFace = 0;
const NO_FACE_THRESHOLD = 10; // 連続フレームで顔なし → エラー扱い

// モデルURL（GitHub Pages公開時は自動で https://ユーザー名.github.io/repo/models/ になる）
const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/';

// モデルロード
async function loadModels() {
    await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),  // ← ssdMobilenetv1 から tiny に変更（高速・軽量）
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceRecognitionNet.loadFromUri(MODEL_URL)
    ]);
    status.textContent = 'モデルロード完了！登録してください。';
}

// カメラ起動
async function startCamera() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true });
        video.srcObject = stream;
        await video.play();
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
    } catch (err) {
        status.textContent = 'カメラエラー: ' + err.message;
    }
}

// 顔検出ヘルパー
async function detectFaces() {
    return await faceapi.detectAllFaces(video, new faceapi.TinyFaceDetectorOptions({ inputSize: 320 }))
        .withFaceLandmarks()
        .withFaceDescriptors();
}

// 登録関数（マスクモード指定）
async function registerFace(isMasked = false) {
    const detections = await detectFaces();
    if (detections.length !== 1) {
        alert('ちょうど1つの顔を検出してください。');
        return;
    }

    const descriptor = detections[0].descriptor;
    const label = isMasked ? 'owner_mask' : 'owner_no_mask';

    // LocalStorageから既存読み込み
    let stored = JSON.parse(localStorage.getItem('registeredFaces')) || { no_mask: [], with_mask: [] };

    // 配列に追加（Float32Array → 普通の配列で保存）
    const descArray = Array.from(descriptor);
    if (isMasked) {
        stored.with_mask.push(descArray);
    } else {
        stored.no_mask.push(descArray);
    }

    localStorage.setItem('registeredFaces', JSON.stringify(stored));
    status.textContent = `登録完了！ (${isMasked ? 'マスクあり' : 'マスクなし'}) 合計: ${stored.no_mask.length + stored.with_mask.length}枚`;
    loadFaceMatcher();
}

// FaceMatcher再構築
function loadFaceMatcher() {
    const stored = JSON.parse(localStorage.getItem('registeredFaces')) || { no_mask: [], with_mask: [] };

    const descriptors = [];
    if (stored.no_mask.length > 0) {
        descriptors.push(new faceapi.LabeledFaceDescriptors('owner_no_mask', stored.no_mask.map(d => new Float32Array(d))));
    }
    if (stored.with_mask.length > 0) {
        descriptors.push(new faceapi.LabeledFaceDescriptors('owner_mask', stored.with_mask.map(d => new Float32Array(d))));
    }

    if (descriptors.length > 0) {
        faceMatcher = new faceapi.FaceMatcher(descriptors, 0.58); // 閾値0.58（マスク考慮で少し緩め）
        console.log('Matcher更新: ', descriptors.length, 'クラス');
    } else {
        faceMatcher = null;
    }
}

// 監視ループ
async function monitorLoop() {
    if (!monitoring) return;

    const detections = await detectFaces();
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const displaySize = { width: video.width, height: video.height };
    faceapi.matchDimensions(canvas, displaySize);
    const resizedDetections = faceapi.resizeResults(detections, displaySize);
    faceapi.draw.drawDetections(canvas, resizedDetections);

    let ownerPresent = false;
    let intruderDetected = false;

    if (detections.length === 0) {
        consecutiveNoFace++;
    } else {
        consecutiveNoFace = 0;
        resizedDetections.forEach(det => {
            if (faceMatcher) {
                const bestMatch = faceMatcher.findBestMatch(det.descriptor);
                if (bestMatch.distance < 0.58 && (bestMatch.label === 'owner_no_mask' || bestMatch.label === 'owner_mask')) {
                    ownerPresent = true;
                } else if (bestMatch.label !== 'unknown') {
                    intruderDetected = true;
                }
            }
        });
    }

    window.ownerAbsent = !ownerPresent;

    if (consecutiveNoFace >= NO_FACE_THRESHOLD) {
        status.textContent = '顔が長時間検出されません（カメラ確認）';
        window.ownerAbsent = true; // 安全側
    } else if (intruderDetected) {
        status.textContent = '不審者（登録外の顔）検出！';
    } else if (ownerPresent) {
        status.textContent = 'オーナー確認中...';
    } else {
        status.textContent = 'オーナー不在';
    }

    setTimeout(monitorLoop, 50); // 約20fps、負荷軽減
}

// 入力ハンドラ（タブ可視時のみ）
let isTabVisible = true;
document.addEventListener('visibilitychange', () => {
    isTabVisible = !document.hidden;
});

function handleInput(e) {
    if (window.ownerAbsent && isTabVisible) {
        console.log('不正入力検出！', 'イベント:', e.type, 'ownerAbsent:', window.ownerAbsent);

        // 画面表示強化
        status.innerHTML = '<span style="color:red; font-size:32px; font-weight:bold; animation: blink 1s infinite;">警報！ 不正操作検出</span>';

        // オーバーレイ表示（5秒間）
        alertOverlay.style.display = 'flex';
        setTimeout(() => {
            alertOverlay.style.display = 'none';
        }, 5000);

        // 音再生
        alertAudio.currentTime = 0;
        alertAudio.play()
            .then(() => console.log('警報音再生OK'))
            .catch(err => {
                console.error('警報音失敗:', err);
                status.innerHTML += '<br><small>(音が出ない場合: ページをクリック → もう一度操作してみて)</small>';
            });
    }
}

// イベントリスナー
registerNoMaskBtn.addEventListener('click', () => registerFace(false));
registerMaskBtn.addEventListener('click', () => registerFace(true));

startMonitorBtn.addEventListener('click', async () => {
    if (!faceMatcher) {
        alert('少なくとも1つ顔を登録してください。');
        return;
    }

    // ★ Audioアンロック（ブラウザポリシー回避の重要部分）
    try {
        alertAudio.currentTime = 0;
        alertAudio.volume = 0;          // 無音で再生
        await alertAudio.play();        // これでポリシー解除
        alertAudio.pause();
        alertAudio.volume = 1;          // 元に戻す
        console.log('音声再生許可が解除されました');
        status.textContent += ' (音声OK)';
    } catch (err) {
        console.error('音声アンロック失敗:', err);
        status.innerHTML += '<br><span style="color:orange;">音声がブロックされています。もう一度「監視開始」を押すか、ページをクリックしてください。</span>';
    }

    monitoring = true;
    status.textContent = '監視開始！';
    monitorLoop();

    // 入力イベント登録（重複防止のため一度removeしてからadd）
    document.removeEventListener('keydown', handleInput);
    document.removeEventListener('mousemove', handleInput);
    document.removeEventListener('click', handleInput);
    document.addEventListener('keydown', handleInput);
    document.addEventListener('mousemove', handleInput);
    document.addEventListener('click', handleInput);
});

// 初期化
async function init() {
    await loadModels();
    await startCamera();
    loadFaceMatcher(); // 過去登録があればロード
    if (faceMatcher) {
        status.textContent = '過去登録あり。監視可能（または再登録）。';
    }
}
init();
