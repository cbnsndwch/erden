//! The data values the proof checker compares on its own (reasoner/protocol/src/literal-values.ts):
//! two literals of a functional data property are a certified clash only when both are in one of
//! these value spaces and their values differ.

use serde_json::Value;

const XSD: &str = "http://www.w3.org/2001/XMLSchema#";
const RDF_LANG_STRING: &str = "http://www.w3.org/1999/02/22-rdf-syntax-ns#langString";
const INTEGER_TYPES: [&str; 13] = [
    "integer",
    "nonNegativeInteger",
    "nonPositiveInteger",
    "positiveInteger",
    "negativeInteger",
    "long",
    "int",
    "short",
    "byte",
    "unsignedLong",
    "unsignedInt",
    "unsignedShort",
    "unsignedByte",
];

/// A decimal's canonical value: sign, integer digits without leading zeros, fraction without
/// trailing zeros (`/^([+-]?)([0-9]*)(?:\.([0-9]*))?$/`).
fn decimal_value(lexical: &str) -> Option<String> {
    let (sign, rest) = match lexical.as_bytes().first() {
        Some(b'+') => ("", &lexical[1..]),
        Some(b'-') => ("-", &lexical[1..]),
        _ => ("", lexical),
    };
    let (whole, fraction) = match rest.split_once('.') {
        Some((whole, fraction)) => (whole, fraction),
        None => (rest, ""),
    };
    if !whole.bytes().all(|byte| byte.is_ascii_digit())
        || !fraction.bytes().all(|byte| byte.is_ascii_digit())
        || (whole.is_empty() && fraction.is_empty())
    {
        return None;
    }
    let whole = whole.trim_start_matches('0');
    let fraction = fraction.trim_end_matches('0');
    if whole.is_empty() && fraction.is_empty() {
        return Some("0".into());
    }
    let whole = if whole.is_empty() { "0" } else { whole };
    Some(if fraction.is_empty() {
        format!("{sign}{whole}")
    } else {
        format!("{sign}{whole}.{fraction}")
    })
}

/// JavaScript's `String.prototype.trim` for the lexical forms the checker trims.
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c: char| c.is_whitespace() || c == '\u{feff}')
}

/// The literal's value as a string equal for two literals exactly when their values are equal, or
/// `None` outside the compared datatypes or for an ill-formed lexical form.
pub(crate) fn comparable_value(literal: &Value) -> Option<String> {
    let datatype = literal.get("datatype")?.as_str()?;
    let lexical = literal.get("lexicalForm")?.as_str()?;
    let local = datatype.strip_prefix(XSD);
    if local == Some("string") {
        return Some(format!("string:{lexical}"));
    }
    if datatype == RDF_LANG_STRING {
        let language = literal.get("language")?.as_str()?;
        return Some(format!("langString:{}:{lexical}", language.to_lowercase()));
    }
    if local == Some("boolean") {
        return match js_trim(lexical) {
            "true" | "1" => Some("boolean:true".into()),
            "false" | "0" => Some("boolean:false".into()),
            _ => None,
        };
    }
    let integer = local.is_some_and(|name| INTEGER_TYPES.contains(&name));
    if local == Some("decimal") || integer {
        let trimmed = js_trim(lexical);
        if integer && trimmed.contains('.') {
            return None;
        }
        return decimal_value(trimmed).map(|value| format!("decimal:{value}"));
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn literal(lexical: &str, datatype: &str) -> Value {
        json!({"datatype": datatype, "kind": "Literal", "language": null, "lexicalForm": lexical})
    }

    #[test]
    fn compares_like_the_checker() {
        let integer = format!("{XSD}integer");
        let decimal = format!("{XSD}decimal");
        assert_eq!(
            comparable_value(&literal("007", &integer)),
            Some("decimal:7".into())
        );
        assert_eq!(
            comparable_value(&literal("7.00", &decimal)),
            Some("decimal:7".into())
        );
        assert_eq!(
            comparable_value(&literal("-0.50", &decimal)),
            Some("decimal:-0.5".into())
        );
        assert_eq!(
            comparable_value(&literal("-0", &decimal)),
            Some("decimal:0".into())
        );
        assert_eq!(comparable_value(&literal(".", &decimal)), None);
        assert_eq!(comparable_value(&literal("1.5", &integer)), None);
        assert_eq!(
            comparable_value(&literal(" 1 ", &format!("{XSD}boolean"))),
            Some("boolean:true".into())
        );
        assert_eq!(
            comparable_value(&literal("1", &format!("{XSD}float"))),
            None
        );
    }
}
