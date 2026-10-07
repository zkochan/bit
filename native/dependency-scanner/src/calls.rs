use oxc_ast::ast::{CallExpression, Expression};
pub(crate) fn accepted(node: &CallExpression<'_>, ts: bool) -> bool {
    (ts || !node.optional)
        && match &node.callee {
            Expression::Identifier(id) => id.name == "require",
            Expression::StaticMemberExpression(m) => {
                m.property.name == "resolve"
                    && match &m.object {
                        Expression::Identifier(id) => id.name == "require",
                        Expression::ImportMeta(_) => true,
                        _ => false,
                    }
            }
            Expression::ComputedMemberExpression(m) => {
                matches!(&m.expression,Expression::Identifier(id) if id.name=="resolve")
                    && (matches!(&m.object,Expression::Identifier(id) if id.name=="require")
                        || matches!(&m.object, Expression::ImportMeta(_)))
            }
            _ => false,
        }
}
