# BatchMesh — Meshy 캐릭터 시트 배치 파이프라인

캐릭터 시트(턴어라운드) 이미지를 넣으면 뷰를 자동 분해하고, 검수 후 Meshy API로 3D 모델을 생성하는 로컬 웹 도구.

## 준비

```
npm install
```

- `.env`에 `MESHY_API_KEY=msy_...` (`.env.example` 참고)
- 환경변수 `GOOGLE_API_KEY` — 시트 자동 분해(Gemini 비전) 및 2K 업스케일용

## 사용

```
node server.mjs      →  http://localhost:3838
```

1. **시트 드래그** → front/left/back/right/face 자동 크롭 (전신 1장만 넣으면 싱글 이미지 모드)
2. **검수** — 크롭별 삭제(✕) / 2K 업스케일 / 힌트 재분해, 이미지 위 📂 폴더 열기·📋 경로 복사
3. **승인 → 3D 생성 시작** — 하이폴리 생성, 진행률 카드 표시
4. **로우폴리 추출** — 완성 버전에서 원하는 폴리곤 수로 추출(원본 하이폴리 기준이라 반복 추출해도 품질 유지)
5. 결과는 `output/<id>/gen-<일시>/`에 버전별로 축적. 카드의 소형 3D 뷰어(풀 쉐이딩/클레이/와이어/그리드/조명), 히스토리 보관 지원

**기하 먼저 검수 모드**(옵션): 텍스처 없이 기하만 생성(크레딧 절약) → 형상 확인 → "텍스처 입히기"로 마감.

## 생성 옵션

웹 상단 패널에서 편집하고 "옵션 저장"을 누르면 `config.json`에 기록되어 **다음 생성부터 모든 캐릭터에 동일 적용**된다.

| 옵션 | 값 | 메모 |
|---|---|---|
| AI 모델 | `latest`(=meshy-7) / `meshy-6` | |
| 포맷 | GLB / FBX (복수 선택) | 3D 뷰어는 GLB 필요 |
| 텍스처 해상도 | 1k / 2k / 4k | |
| 텍스처 생성 · PBR 맵 | on/off | |
| 포즈 | A-포즈 / T-포즈 | 리깅 예정이면 A-포즈 |
| 이미지 보정 | on/off | Meshy 자동 인헨스(API 기본값 on) |
| 조명 제거 | on/off | 시트 음영을 텍스처에서 제거 |
| 실측 크기 자동 · Ultra 모드 | on/off | |
| 기하 먼저 생성 후 검수 | on/off | 위 참조 |

생성은 **항상 하이폴리**로 진행하고, 로우폴리는 완성 버전에서 추출한다(면수를 바꿔 반복 추출해도 원본 하이폴리에서 깎으므로 품질이 유지됨).

## CLI

```
node scripts/run_batch.mjs --dry-run     # 매칭 확인만
node scripts/run_batch.mjs --only id1,id2 --force
node scripts/split_sheet.mjs <sheet.png> <outDir> [힌트]
```

크롭을 직접 넣을 때는 `input/<캐릭터id>/front.png` (left/back/right/face) 규약을 따른다.

## Meshy API 제약 (실측)

- **Smart Topology(`model_type`, meshy-t2)는 Text-to-3D 전용** — image/multi-image-to-3d에는 없음. 이미지 입력에서 게임용 토폴로지는 쿼드 리메시로 얻는다.
- **Retexture의 `multiview_image_urls`는 `ai_model: "meshy-7"` 필수** (`latest` 거부).
- `ultra_mode`는 현재 서비스에서 비활성(`false`여도 전송하면 400) — 러너가 꺼져 있으면 필드를 아예 보내지 않는다.
- `symmetry_mode`는 multi-image-to-3d에서 deprecated라 옵션에서 제거함.
- 크레딧: image→3D 20~30, remesh/retexture ~10. **실패(FAILED) 태스크는 환불**, 성공했지만 마음에 안 드는 결과는 정가.
- 결과 URL은 **3일 후 만료** — 러너가 완료 즉시 로컬 저장.
- 업로드 이미지 20MB 제한 — 초과 시 자동으로 JPG 전환(필요하면 4096px 리사이즈).

## 메모

- 2K 업스케일은 Gemini 이미지 모델 사용 (Vertex Imagen 업스케일은 2026-06 은퇴)
- `input/` `output/` `staging/` `history/` `logs/`는 데이터 폴더라 git에서 제외
