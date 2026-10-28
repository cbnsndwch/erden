//! Interned IRIs, property expressions and class expressions of one request, with the canonical key and JSON of each.
//!
//! An expression's key is the JSON the TypeScript protocol sorts class expressions by (`classExpressionKey`: fields in
//! schema order, `kind` first), compared as UTF-16. Contexts are sorted sets of expressions under that order.

use serde_json::{Value, json};
use std::cmp::Ordering;
use std::collections::HashMap;

pub(crate) type Sym = u32;
pub(crate) type PropId = u32;
pub(crate) type ExprId = u32;

pub(crate) const OWL_THING: &str = "http://www.w3.org/2002/07/owl#Thing";
pub(crate) const OWL_NOTHING: &str = "http://www.w3.org/2002/07/owl#Nothing";

#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum Expr {
    Named(Sym),
    /// V1's union of named classes, operands sorted.
    Union(Vec<Sym>),
    /// Operands sorted by key, unique.
    Inter(Vec<ExprId>),
    Some(PropId, ExprId),
    All(PropId, ExprId),
    Max(u8, PropId, ExprId),
    Not(ExprId),
}

#[derive(Default)]
pub(crate) struct Model {
    iris: Vec<String>,
    iri_ids: HashMap<String, Sym>,
    props: Vec<(Sym, bool)>,
    prop_ids: HashMap<(Sym, bool), PropId>,
    exprs: Vec<Expr>,
    expr_ids: HashMap<Expr, ExprId>,
    keys: Vec<String>,
    utf16: Vec<Box<[u16]>>,
}

fn quoted(value: &str) -> String {
    serde_json::to_string(value).expect("strings serialize as JSON")
}

impl Model {
    pub(crate) fn iri(&mut self, iri: &str) -> Sym {
        if let Some(&id) = self.iri_ids.get(iri) {
            return id;
        }
        let id = self.iris.len() as Sym;
        self.iris.push(iri.to_owned());
        self.iri_ids.insert(iri.to_owned(), id);
        id
    }

    pub(crate) fn iri_text(&self, sym: Sym) -> &str {
        &self.iris[sym as usize]
    }

    pub(crate) fn prop(&mut self, sym: Sym, inverse: bool) -> PropId {
        if let Some(&id) = self.prop_ids.get(&(sym, inverse)) {
            return id;
        }
        let id = self.props.len() as PropId;
        self.props.push((sym, inverse));
        self.prop_ids.insert((sym, inverse), id);
        id
    }

    pub(crate) fn find_prop(&self, sym: Sym, inverse: bool) -> Option<PropId> {
        self.prop_ids.get(&(sym, inverse)).copied()
    }

    pub(crate) fn prop_parts(&self, prop: PropId) -> (Sym, bool) {
        self.props[prop as usize]
    }

    pub(crate) fn inverse(&mut self, prop: PropId) -> PropId {
        let (sym, inverse) = self.prop_parts(prop);
        self.prop(sym, !inverse)
    }

    pub(crate) fn prop_count(&self) -> usize {
        self.props.len()
    }

    fn prop_key(&self, prop: PropId) -> String {
        let (sym, inverse) = self.prop_parts(prop);
        if inverse {
            format!(
                "{{\"kind\":\"ObjectInverseOf\",\"property\":{}}}",
                quoted(self.iri_text(sym))
            )
        } else {
            quoted(self.iri_text(sym))
        }
    }

    pub(crate) fn prop_json(&self, prop: PropId) -> Value {
        let (sym, inverse) = self.prop_parts(prop);
        if inverse {
            json!({"kind": "ObjectInverseOf", "property": self.iri_text(sym)})
        } else {
            Value::String(self.iri_text(sym).to_owned())
        }
    }

    pub(crate) fn expr(&self, id: ExprId) -> &Expr {
        &self.exprs[id as usize]
    }

    pub(crate) fn key(&self, id: ExprId) -> &str {
        &self.keys[id as usize]
    }

    pub(crate) fn cmp(&self, left: ExprId, right: ExprId) -> Ordering {
        self.utf16[left as usize].cmp(&self.utf16[right as usize])
    }

    fn compute_key(&self, expr: &Expr) -> String {
        match expr {
            Expr::Named(sym) => format!(
                "{{\"kind\":\"NamedClass\",\"iri\":{}}}",
                quoted(self.iri_text(*sym))
            ),
            Expr::Union(operands) => {
                let items: Vec<String> = operands
                    .iter()
                    .map(|sym| quoted(self.iri_text(*sym)))
                    .collect();
                format!(
                    "{{\"kind\":\"ObjectUnionOf\",\"operands\":[{}]}}",
                    items.join(",")
                )
            }
            Expr::Inter(operands) => {
                let items: Vec<&str> = operands.iter().map(|id| self.key(*id)).collect();
                format!(
                    "{{\"kind\":\"ObjectIntersectionOf\",\"operands\":[{}]}}",
                    items.join(",")
                )
            }
            Expr::Some(prop, filler) | Expr::All(prop, filler) => format!(
                "{{\"kind\":\"{}\",\"property\":{},\"filler\":{}}}",
                if matches!(expr, Expr::Some(..)) {
                    "ObjectSomeValuesFrom"
                } else {
                    "ObjectAllValuesFrom"
                },
                self.prop_key(*prop),
                self.key(*filler)
            ),
            Expr::Max(cardinality, prop, filler) => format!(
                "{{\"kind\":\"ObjectMaxCardinality\",\"cardinality\":{cardinality},\"property\":{},\"filler\":{}}}",
                self.prop_key(*prop),
                self.key(*filler)
            ),
            Expr::Not(operand) => format!(
                "{{\"kind\":\"ObjectComplementOf\",\"operand\":{}}}",
                self.key(*operand)
            ),
        }
    }

    pub(crate) fn intern(&mut self, expr: Expr) -> ExprId {
        if let Some(&id) = self.expr_ids.get(&expr) {
            return id;
        }
        let key = self.compute_key(&expr);
        let id = self.exprs.len() as ExprId;
        self.utf16.push(key.encode_utf16().collect());
        self.keys.push(key);
        self.exprs.push(expr.clone());
        self.expr_ids.insert(expr, id);
        id
    }

    pub(crate) fn find(&self, expr: &Expr) -> Option<ExprId> {
        self.expr_ids.get(expr).copied()
    }

    pub(crate) fn named(&mut self, iri: &str) -> ExprId {
        let sym = self.iri(iri);
        self.intern(Expr::Named(sym))
    }

    /// An intersection of `parts` in canonical form: flattened, sorted, unique; one part stands alone.
    pub(crate) fn context(&mut self, parts: &[ExprId]) -> (Vec<ExprId>, ExprId) {
        let mut flat = Vec::new();
        for &part in parts {
            self.flatten_into(part, &mut flat);
        }
        flat.sort_by(|left, right| self.cmp(*left, *right));
        flat.dedup();
        let expression = if flat.len() == 1 {
            flat[0]
        } else {
            self.intern(Expr::Inter(flat.clone()))
        };
        (flat, expression)
    }

    fn flatten_into(&self, part: ExprId, flat: &mut Vec<ExprId>) {
        if let Expr::Inter(operands) = self.expr(part) {
            for &operand in operands {
                self.flatten_into(operand, flat);
            }
        } else {
            flat.push(part);
        }
    }

    /// Reads a property expression of the request.
    pub(crate) fn parse_prop(&mut self, value: &Value) -> Result<PropId, String> {
        if let Some(iri) = value.as_str() {
            let sym = self.iri(iri);
            return Ok(self.prop(sym, false));
        }
        if value.get("kind").and_then(Value::as_str) == Some("ObjectInverseOf") {
            let iri = value
                .get("property")
                .and_then(Value::as_str)
                .ok_or("ObjectInverseOf needs a property")?;
            let sym = self.iri(iri);
            return Ok(self.prop(sym, true));
        }
        Err("invalid property expression".into())
    }

    /// Reads a class expression of the request.
    pub(crate) fn parse(&mut self, value: &Value) -> Result<ExprId, String> {
        let kind = value
            .get("kind")
            .and_then(Value::as_str)
            .ok_or("class expression kind missing")?;
        let field = |name: &str| value.get(name).ok_or(format!("{kind} needs {name}"));
        let expr = match kind {
            "NamedClass" => {
                let iri = field("iri")?.as_str().ok_or("iri must be a string")?;
                Expr::Named(self.iri(iri))
            }
            "ObjectUnionOf" => {
                let mut operands = Vec::new();
                for operand in field("operands")?.as_array().ok_or("operands")? {
                    operands.push(self.iri(operand.as_str().ok_or("union operand")?));
                }
                Expr::Union(operands)
            }
            "ObjectIntersectionOf" => {
                let mut operands = Vec::new();
                for operand in field("operands")?.as_array().ok_or("operands")? {
                    operands.push(self.parse(operand)?);
                }
                operands.sort_by(|left, right| self.cmp(*left, *right));
                operands.dedup();
                Expr::Inter(operands)
            }
            "ObjectSomeValuesFrom" | "ObjectAllValuesFrom" => {
                let prop = self.parse_prop(field("property")?)?;
                let filler = self.parse(field("filler")?)?;
                if kind == "ObjectSomeValuesFrom" {
                    Expr::Some(prop, filler)
                } else {
                    Expr::All(prop, filler)
                }
            }
            "ObjectMaxCardinality" => {
                let cardinality = field("cardinality")?
                    .as_u64()
                    .filter(|value| *value <= 1)
                    .ok_or("cardinality must be 0 or 1")?;
                let prop = self.parse_prop(field("property")?)?;
                let filler = self.parse(field("filler")?)?;
                Expr::Max(cardinality as u8, prop, filler)
            }
            "ObjectComplementOf" => Expr::Not(self.parse(field("operand")?)?),
            _ => return Err(format!("{kind} is not a Horn class expression")),
        };
        Ok(self.intern(expr))
    }

    /// The canonical JSON of an expression (object keys sorted by `serde_json`).
    pub(crate) fn to_json(&self, id: ExprId) -> Value {
        match self.expr(id) {
            Expr::Named(sym) => json!({"iri": self.iri_text(*sym), "kind": "NamedClass"}),
            Expr::Union(operands) => json!({
                "kind": "ObjectUnionOf",
                "operands": operands.iter().map(|sym| self.iri_text(*sym)).collect::<Vec<_>>()
            }),
            Expr::Inter(operands) => json!({
                "kind": "ObjectIntersectionOf",
                "operands": operands.iter().map(|operand| self.to_json(*operand)).collect::<Vec<_>>()
            }),
            Expr::Some(prop, filler) => json!({
                "filler": self.to_json(*filler),
                "kind": "ObjectSomeValuesFrom",
                "property": self.prop_json(*prop)
            }),
            Expr::All(prop, filler) => json!({
                "filler": self.to_json(*filler),
                "kind": "ObjectAllValuesFrom",
                "property": self.prop_json(*prop)
            }),
            Expr::Max(cardinality, prop, filler) => json!({
                "cardinality": cardinality,
                "filler": self.to_json(*filler),
                "kind": "ObjectMaxCardinality",
                "property": self.prop_json(*prop)
            }),
            Expr::Not(operand) => {
                json!({"kind": "ObjectComplementOf", "operand": self.to_json(*operand)})
            }
        }
    }

    pub(crate) fn named_iri(&self, id: ExprId) -> Option<&str> {
        match self.expr(id) {
            Expr::Named(sym) => Some(self.iri_text(*sym)),
            _ => None,
        }
    }
}
