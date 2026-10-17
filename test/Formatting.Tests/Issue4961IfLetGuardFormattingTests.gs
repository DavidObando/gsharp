// <copyright file="Issue4961IfLetGuardFormattingTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Formatting.Tests

import GSharp.Core.CodeAnalysis.Text
import GSharp.Formatting
import Xunit

/// Issue #4961 / ADR-0200: gsfmt formats the statement-form `if let` guard
/// like the expression form's, keeps parenthesized and `?:` initializers
/// intact in both forms, and is idempotent.
class Issue4961IfLetGuardFormattingTests {
    @Fact
    func StatementAndExpressionGuards_FormatCanonically_AndIdempotently() {
        const source = `package P
func Run(s string?,t string?,flag bool) {
    if let a=s,let b=t&&a.Length>0&&b.Length>0 {
        Use(a)
    } else if let c=s&&c.Length==0 {
        Use(c)
    }
    if let d=(flag&&true?s:t)&&d.Length>1 {
        Use(d)
    }
    if let e=flag?s:t&&e.Length>1 {
        Use(e)
    }
    let r=if let v=s&&v.Length>0 { v } else { "" }
    let q=if let w=flag?s:t&&w.Length>1 { w } else { "" }
}`
        let result = GSharpFormatter.Format(SourceText.From(source))
        Assert.Empty(result.Diagnostics)
        let text = result.Text!!.ToString()
        Assert.Contains("    if let a = s, let b = t && a.Length > 0 && b.Length > 0 {", text)
        Assert.Contains("    } else if let c = s && c.Length == 0 {", text)
        // The `?:` arms themselves are left to the general ternary rule (issue
        // #4981 spaces them `? s: t`); only the guard's layout is pinned here.
        Assert.Contains("    if let d = (flag && true ? s", text)
        Assert.Contains("t) && d.Length > 1 {", text)
        Assert.Contains("    if let e = flag ? s", text)
        Assert.Contains("t && e.Length > 1 {", text)
        Assert.Contains("    let r = if let v = s && v.Length > 0 {", text)
        // ADR-0200: the expression form now parses a `?:` initializer too
        // (it was a parse error, so gsfmt reported diagnostics).
        Assert.Contains("    let q = if let w = flag ? s", text)
        Assert.Contains("t && w.Length > 1 {", text)
        Assert.Equal(text, GSharpFormatter.Format(result.Text!!).Text!!.ToString())
    }
}
