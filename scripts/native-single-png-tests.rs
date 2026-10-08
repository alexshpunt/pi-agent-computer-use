// Appended to the pinned core owner by prepare-native-single-png.mjs.
#[cfg(test)]
mod single_png_tests {
    use super::*;

    fn pixels(w: u32, h: u32) -> Vec<u8> {
        (0..w * h)
            .flat_map(|n| {
                [
                    n.wrapping_mul(17) as u8,
                    n.wrapping_mul(29) as u8,
                    n.wrapping_mul(43) as u8,
                    n.wrapping_mul(61) as u8,
                ]
            })
            .collect()
    }

    #[test]
    fn single_png_matches_legacy_decoded_pixels_and_dimensions() {
        for (w, h) in [(37, 19), (19, 37), (65, 65), (400, 1), (1, 400)] {
            let bgra = pixels(w, h);
            let native = encode_bgra_to_png(&bgra, w, h).unwrap();
            for cap in [0, 1, 7, 17, 37, 500] {
                let old = resize_png_if_needed(&native, cap).unwrap();
                let new = encode_bgra_to_png_resized(&bgra, w, h, cap).unwrap();
                let old = image::load_from_memory(&old).unwrap().to_rgba8();
                let new = image::load_from_memory(&new).unwrap().to_rgba8();
                assert_eq!(new, old, "{w}x{h}, cap={cap}");
            }
        }
    }

    #[test]
    fn single_png_native_and_within_cap_keep_encoded_bytes() {
        let bgra = pixels(37, 19);
        let old = encode_bgra_to_png(&bgra, 37, 19).unwrap();
        for cap in [0, 37, 500] {
            assert_eq!(encode_bgra_to_png_resized(&bgra, 37, 19, cap).unwrap(), old);
        }
    }

    #[test]
    fn single_png_keeps_bgra_channels_and_alpha() {
        let new = encode_bgra_to_png_resized(&[10, 20, 30, 40], 1, 1, 0).unwrap();
        assert_eq!(
            image::load_from_memory(&new).unwrap().to_rgba8().as_raw(),
            &[30, 20, 10, 40]
        );
    }

    #[test]
    fn single_png_rejects_invalid_buffer_before_encoding() {
        for cap in [0, 1, 500] {
            assert!(encode_bgra_to_png_resized(&[0; 3], 1, 1, cap).is_err());
            assert!(encode_bgra_to_png_resized(&[0; 8], 1, 1, cap).is_err());
        }
    }
}
