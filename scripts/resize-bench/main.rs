//! Standalone, single-threaded resize comparison. PNG work is outside the timer.
use fast_image_resize as fir;
use image::{imageops, RgbaImage};
use pic_scale::{ImageSize, ImageStore, ImageStoreMut, ResamplingFunction as Pic, Scaler};
use serde_json::json;
use std::{error::Error, fs, hint::black_box, path::PathBuf, time::Instant};

type Result<T> = std::result::Result<T, Box<dyn Error>>;

#[derive(Clone, Copy)]
enum Method {
    Image(imageops::FilterType),
    Fast(fir::ResizeAlg),
    Pic(Pic),
}

impl Method {
    fn name(self) -> String {
        match self {
            Self::Image(f) => format!("image-{f:?}"),
            Self::Fast(fir::ResizeAlg::Nearest) => "fast-Nearest".into(),
            Self::Fast(fir::ResizeAlg::Convolution(f)) => format!("fast-{f:?}"),
            Self::Fast(_) => unreachable!(),
            Self::Pic(f) => format!("pic-{f:?}"),
        }
    }

    // Each call allocates its output and rebuilds coefficients/scratch state.
    // No library gets a cached plan while another pays for planning.
    fn resize(self, src: &RgbaImage, width: u32, height: u32) -> Result<Vec<u8>> {
        match self {
            Self::Image(filter) => Ok(imageops::resize(src, width, height, filter).into_raw()),
            Self::Fast(algorithm) => {
                let input = fir::images::ImageRef::new(
                    src.width(),
                    src.height(),
                    src.as_raw(),
                    fir::PixelType::U8x4,
                )?;
                let mut output = fir::images::Image::new(width, height, fir::PixelType::U8x4);
                let options = fir::ResizeOptions::new()
                    .resize_alg(algorithm)
                    .use_alpha(false);
                fir::Resizer::new().resize(&input, &mut output, &options)?;
                Ok(output.into_vec())
            }
            Self::Pic(filter) => {
                let input = ImageStore::<u8, 4>::from_slice(
                    src.as_raw(),
                    src.width() as usize,
                    src.height() as usize,
                )?;
                let mut bytes = vec![0; width as usize * height as usize * 4];
                let mut output = ImageStoreMut::<u8, 4>::from_slice(
                    &mut bytes,
                    width as usize,
                    height as usize,
                )?;
                let plan = Scaler::new(filter).plan_rgba_resampling(
                    ImageSize::new(src.width() as usize, src.height() as usize),
                    ImageSize::new(width as usize, height as usize),
                    false,
                )?;
                plan.resample(&input, &mut output)?;
                Ok(bytes)
            }
        }
    }
}

fn methods() -> Vec<Method> {
    use fir::FilterType as F;
    use imageops::FilterType as I;
    let mut methods = vec![
        Method::Image(I::Nearest),
        Method::Image(I::Triangle),
        Method::Image(I::CatmullRom),
        Method::Image(I::Gaussian),
        Method::Image(I::Lanczos3),
        Method::Fast(fir::ResizeAlg::Nearest),
    ];
    methods.extend(
        [
            F::Box,
            F::Bilinear,
            F::Hamming,
            F::CatmullRom,
            F::Mitchell,
            F::Gaussian,
            F::Lanczos3,
        ]
        .map(|f| Method::Fast(fir::ResizeAlg::Convolution(f))),
    );
    // Every built-in ResamplingFunction in pinned pic-scale 0.7.12.
    methods.extend(
        [
            Pic::Bilinear,
            Pic::Nearest,
            Pic::Cubic,
            Pic::MitchellNetravalli,
            Pic::CatmullRom,
            Pic::Hermite,
            Pic::BSpline,
            Pic::Hann,
            Pic::Bicubic,
            Pic::Hamming,
            Pic::Hanning,
            Pic::EwaHanning,
            Pic::Blackman,
            Pic::EwaBlackman,
            Pic::Welch,
            Pic::Quadric,
            Pic::EwaQuadric,
            Pic::Gaussian,
            Pic::Sphinx,
            Pic::Bartlett,
            Pic::Robidoux,
            Pic::EwaRobidoux,
            Pic::RobidouxSharp,
            Pic::EwaRobidouxSharp,
            Pic::Spline16,
            Pic::Spline36,
            Pic::Spline64,
            Pic::Kaiser,
            Pic::BartlettHann,
            Pic::Box,
            Pic::Bohman,
            Pic::Lanczos2,
            Pic::Lanczos3,
            Pic::Lanczos4,
            Pic::Lanczos5,
            Pic::Lanczos6,
            Pic::Lanczos2Jinc,
            Pic::Lanczos3Jinc,
            Pic::Lanczos4Jinc,
            Pic::Lanczos5Jinc,
            Pic::Lanczos6Jinc,
            Pic::EwaLanczos3,
            Pic::Ginseng,
            Pic::EwaGinseng,
            Pic::EwaLanczosSharp,
            Pic::EwaLanczos4Sharpest,
            Pic::EwaLanczosSoft,
            Pic::HaasnSoft,
            Pic::Lagrange2,
            Pic::Lagrange3,
            Pic::EwaMitchellNetravalli,
            Pic::EwaCatmullRom,
            Pic::Area,
        ]
        .map(Method::Pic),
    );
    methods
}

fn dimensions(width: u32, height: u32, cap: u32) -> (u32, u32) {
    let scale = f64::from(cap.min(width.max(height))) / f64::from(width.max(height));
    (
        (f64::from(width) * scale).round().max(1.0) as u32,
        (f64::from(height) * scale).round().max(1.0) as u32,
    )
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() as f64 * p).ceil() as usize).saturating_sub(1)]
}

fn main() -> Result<()> {
    let args: Vec<_> = std::env::args().collect();
    if args.len() != 3 {
        return Err("Usage: resize-bench INPUT.png NEW_OUTPUT_DIRECTORY".into());
    }
    let src = image::open(&args[1])?.into_rgba8();
    if src.pixels().any(|p| p.0[3] != 255) {
        return Err("This opaque-RGBA benchmark rejects transparent input".into());
    }
    let (width, height) = dimensions(src.width(), src.height(), 500);
    let dir = PathBuf::from(&args[2]);
    fs::create_dir(&dir)?; // Never silently overwrite an earlier run.
    let methods = methods();
    let warmups = 3;
    let samples = 40;
    let mut timings = vec![Vec::with_capacity(samples); methods.len()];
    let started = Instant::now();
    for round in 0..warmups + samples {
        // Rotate order to distribute CPU drift across methods.
        for slot in 0..methods.len() {
            if started.elapsed().as_secs() > 180 {
                return Err("Resize benchmark exceeded its 180-second budget".into());
            }
            let index = (slot + round) % methods.len();
            let begin = Instant::now();
            let output = methods[index].resize(black_box(&src), width, height)?;
            let elapsed_ms = begin.elapsed().as_secs_f64() * 1000.0;
            black_box(&output);
            assert_eq!(output.len(), width as usize * height as usize * 4);
            if round >= warmups {
                timings[index].push(elapsed_ms);
            }
        }
    }
    let mut rows = Vec::new();
    for (index, method) in methods.iter().enumerate() {
        let output = method.resize(&src, width, height)?;
        let output_image = RgbaImage::from_raw(width, height, output).ok_or("Bad output length")?;
        let name = method.name();
        output_image.save(dir.join(format!("{name}.png")))?;
        let times = &mut timings[index];
        times.sort_by(f64::total_cmp);
        rows.push(json!({
            "method": name, "median_ms": (times[19] + times[20]) / 2.0,
            "p95_ms": percentile(times, 0.95), "samples_ms": times,
        }));
    }
    rows.sort_by(|a, b| {
        a["median_ms"]
            .as_f64()
            .unwrap()
            .total_cmp(&b["median_ms"].as_f64().unwrap())
    });
    let report = json!({
        "input_dimensions": [src.width(), src.height()], "output_dimensions": [width, height],
        "warmups": warmups, "samples": samples, "method_count": methods.len(),
        "timed": "one-shot resize including output allocation, coefficients and scratch allocation",
        "excluded": ["PNG decode", "PNG encode", "file I/O", "capture", "output destruction"],
        "alpha": "fully opaque RGBA; no premultiplication", "gamma": "no linear-light conversion",
        "threading": "single; rayon features disabled; SIMD auto-selected",
        "versions": {"image": "0.25.10", "fast_image_resize": "6.1.0", "pic-scale": "0.7.12"},
        "cpu_features": {"avx2": std::is_x86_feature_detected!("avx2"), "sse4.1": std::is_x86_feature_detected!("sse4.1")},
        "rows": rows,
    });
    fs::write(dir.join("run.json"), serde_json::to_string_pretty(&report)?)?;
    println!(
        "{}",
        serde_json::to_string_pretty(&json!({
            "method_count": report["method_count"], "output_dimensions": report["output_dimensions"],
            "fastest": report["rows"].as_array().unwrap().iter().take(10).map(|r|
                json!({"method":r["method"],"median_ms":r["median_ms"],"p95_ms":r["p95_ms"]})
            ).collect::<Vec<_>>(), "report": dir.join("run.json"),
        }))?
    );
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn aspect_ratio_rounds_and_never_upscales() {
        assert_eq!(dimensions(1237, 1327, 500), (466, 500));
        assert_eq!(dimensions(100, 50, 500), (100, 50));
        assert_eq!(dimensions(1, 2000, 500), (1, 500));
    }
}
