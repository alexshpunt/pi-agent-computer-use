# Standalone resize benchmark

Compare one screenshot across three pinned Rust libraries. This does not load or change the computer-use extension or its Driver.

[Measured results and visual review](../../docs/research/resize-benchmark.md).

## Run

Use an existing opaque PNG, a Rust toolchain that supports these crates, and a new output directory. The measured run used Rust 1.97.1 on x86-64 WSL2.

```sh
mkdir -p .tmp/resize-bench
CARGO_TARGET_DIR="$PWD/.tmp/resize-bench/target" \
  cargo +1.97.1 run --locked --release \
  --manifest-path scripts/resize-bench/Cargo.toml \
  -- /path/to/screenshot.png .tmp/resize-bench/run
```

The runner rejects transparent input and an existing output directory. It decodes the image once, keeps its aspect ratio, and limits the longest edge to 500 pixels without upscaling. It tests 66 methods: all five `image` filters, `fast_image_resize` Nearest plus seven built-in convolution filters, and all 53 `pic-scale` filters in the pinned version.

Each method gets three warmups and 40 timed samples. Order rotates each round. Each call includes output allocation, filter planning and scratch allocation; plans and scratch buffers are not reused. PNG decoding, encoding, file I/O, capture and output-buffer destruction are outside the timer. The run stops after a 180-second timing budget. All processing is single-threaded, with available SIMD selected by the libraries. No linear-light conversion or alpha premultiplication is used on the opaque RGBA input.

Outputs are one PNG per method and `run.json` with timings, dimensions and settings. Do not mistake matching filter names for identical implementations.

## Inspect outputs

With an existing Python environment containing Pillow:

```sh
python scripts/resize-bench/review.py .tmp/resize-bench/run
```

This creates numbered contact sheets with each output at its actual size, without another resize. `comparison.png` shows four candidates with the top 50 pixels removed to omit the browser toolbar from the measured fixture. Check other sources yourself before sharing: this fixed crop is not a general privacy filter.

The helper is outside the timed benchmark. The original screenshot and full output images should stay in ignored `.tmp/` unless explicitly approved for publication.

## Check the runner

```sh
CARGO_TARGET_DIR="$PWD/.tmp/resize-bench/target" \
  cargo +1.97.1 test --locked --release \
  --manifest-path scripts/resize-bench/Cargo.toml
cargo +1.97.1 fmt --manifest-path scripts/resize-bench/Cargo.toml --check
```

No installed toolchain, runtime or dependencies are silently updated.
