//! Message framing shared by the Debug Adapter Protocol and the Language Server Protocol: `Content-Length` headers
//! followed by a JSON body.

use std::io::{BufRead, BufReader, Read};

pub fn frame(msg: &str) -> Vec<u8> {
    format!("Content-Length: {}\r\n\r\n{}", msg.len(), msg).into_bytes()
}

pub fn read_frames<R: Read>(r: R, mut on_msg: impl FnMut(String)) {
    let mut rd = BufReader::new(r);
    loop {
        let mut len = 0usize;
        let mut line = String::new();
        loop {
            line.clear();
            match rd.read_line(&mut line) {
                Ok(0) | Err(_) => return,
                Ok(_) => {}
            }
            let t = line.trim();
            if t.is_empty() {
                break;
            }
            if let Some(v) = t.strip_prefix("Content-Length:") {
                len = v.trim().parse().unwrap_or(0);
            }
        }
        if len == 0 {
            continue;
        }
        let mut body = vec![0u8; len];
        if rd.read_exact(&mut body).is_err() {
            return;
        }
        on_msg(String::from_utf8_lossy(&body).into_owned());
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn frames_roundtrip() {
        let mut data = frame(r#"{"seq":1}"#);
        data.extend(frame(r#"{"seq":2,"текст":"привет"}"#));
        let mut got = Vec::new();
        read_frames(Cursor::new(data), |m| got.push(m));
        assert_eq!(got, vec![r#"{"seq":1}"#.to_string(), r#"{"seq":2,"текст":"привет"}"#.to_string()]);
    }

    #[test]
    fn truncated_frame_ends_cleanly() {
        let mut got = Vec::new();
        read_frames(Cursor::new(b"Content-Length: 50

{}".to_vec()), |m| got.push(m));
        assert!(got.is_empty());
    }

    #[test]
    fn ignores_other_headers() {
        let mut got = Vec::new();
        let data = b"Content-Type: application/vscode-jsonrpc; charset=utf-8
Content-Length: 2

{}".to_vec();
        read_frames(Cursor::new(data), |m| got.push(m));
        assert_eq!(got, vec!["{}".to_string()]);
    }
}
