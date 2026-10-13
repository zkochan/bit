use super::{
    Request, invalid,
    wire::{snap, unversioned, version},
};
use std::io;

type Choice = Option<(String, Option<String>)>;
pub(super) fn select(
    request: &Request,
    identity: &str,
    field: usize,
    package: Option<&str>,
) -> io::Result<Choice> {
    let base = unversioned(identity);
    let bitmap: Vec<_> = request.sources.bitmap
        .iter()
        .filter(|id| unversioned(id) == base)
        .collect();
    let bitmap = (bitmap.len() == 1).then(|| bitmap[0].as_str());
    if let Some(value) = request.sources.component_config
        .get(base)
        .filter(|value| !value.is_empty())
    {
        return Ok(Some((value.clone(), None)));
    }
    if let Some(name) = package
        && !(request.policy.env_own
            .iter()
            .any(|entry| entry == name)
            && bitmap.is_some())
        && let Some(spec) = request.policy.manual[field]
            .get(name)
            .filter(|value| !value.is_empty())
        && let Some(selected) = valid(request, spec)?
    {
        return Ok(Some(selected));
    }
    if let Some(value) = bitmap.map(version).or_else(|| from_ids(&request.sources.lane, base)) {
        return Ok(Some((value.to_owned(), None)));
    }
    if let Some(name) = package
        && let Some(selected) = package_policy(request, identity, name)?
    {
        return Ok(Some(selected));
    }
    Ok(from_ids(&request.sources.model, base)
        .or_else(|| (version(identity) != "latest").then(|| version(identity)))
        .map(|value| (value.to_owned(), None)))
}
fn from_ids<'a>(ids: &'a [String], identity: &str) -> Option<&'a str> {
    ids.iter()
        .find(|id| unversioned(id) == identity)
        .map(|id| version(id))
}
fn package_policy(request: &Request, identity: &str, name: &str) -> io::Result<Choice> {
    if let version = version(identity)
        && version != "latest"
        && let Some(spec) = request.policy.workspace
            .get(name)
            .filter(|spec| !spec.is_empty())
    {
        let range =
            (request.policy.ranges() && grammar(request, spec)?.range).then(|| spec.clone());
        return Ok(Some((version.to_owned(), range)));
    }
    if let Some(spec) = request.policy.merge
        .iter()
        .filter_map(|map| map.get(name))
        .rfind(|spec| !spec.is_empty())
        && let Some((version, _)) = valid(request, spec)?
    {
        return Ok(Some((version, None)));
    }
    if request.policy.automatic
        .iter()
        .any(|map| {
            map.get(name)
                .is_some_and(|value| !value.is_empty())
        })
    {
        return Ok(Some((version(identity).to_owned(), None)));
    }
    Ok(None)
}
fn valid(request: &Request, spec: &str) -> io::Result<Choice> {
    if let Some(hash) = spec.strip_prefix("0.0.0-")
        && snap(hash)
    {
        return Ok(Some((hash.to_owned(), None)));
    }
    let parsed = grammar(request, spec)?;
    if parsed.valid {
        return Ok(Some((spec.to_owned(), None)));
    }
    if parsed.range
        && let Some(version) = &parsed.coerced
    {
        return Ok(Some((version.clone(), Some(spec.to_owned()))));
    }
    Ok(snap(spec).then(|| (spec.to_owned(), None)))
}
fn grammar<'a>(request: &'a Request, spec: &str) -> io::Result<&'a super::wire::Grammar> {
    request.grammar.get(spec).ok_or_else(|| invalid("dependency version grammar missing"))
}
