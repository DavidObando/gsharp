// <copyright file="Issue4301GeneratedRegexBinderTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using System.Collections.Generic;
using System.Collections.Immutable;
using System.IO;
using System.Linq;
using GSharp.Core.CodeAnalysis;
using GSharp.Core.CodeAnalysis.Binding;
using GSharp.Core.CodeAnalysis.Compilation;
using GSharp.Core.CodeAnalysis.Symbols;
using GSharp.Core.CodeAnalysis.Syntax;
using GSharp.Core.CodeAnalysis.Text;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Binding;

/// <summary>
/// ADR-0187 / issue #4301: <c>@GeneratedRegex</c> is a third attribute
/// discriminator on a bodyless <c>func</c> declaration, alongside
/// <c>@DllImport</c>/<c>@LibraryImport</c> (ADR-0086 §1 / ADR-0092), but
/// with a cached-STATE emission shape borrowed from ADR-0051's
/// auto-property backing-field synthesis instead of ADR-0092's two-method
/// P/Invoke shape. Covers both the static (<c>shared</c>-block) and
/// instance-method forms, the culture-sensitive-<c>IgnoreCase</c>
/// restriction, and the diagnostics GS0593–GS0596.
/// </summary>
public class Issue4301GeneratedRegexBinderTests
{
    [Fact]
    public void StaticGeneratedRegex_BindsAndAttachesMetadata_NoErrors()
    {
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""^[a-z]+$"")
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        var structSym = globalScope.Structs.Single(s => s.Name == "C");
        var method = structSym.StaticMethods.Single(m => m.Name == "Pattern");

        Assert.True(method.IsGeneratedRegex);
        Assert.NotNull(method.GeneratedRegexMetadata);
        Assert.Equal("^[a-z]+$", method.GeneratedRegexMetadata.Pattern);
        Assert.NotNull(method.GeneratedRegexBackingField);
        Assert.True(method.GeneratedRegexBackingField.IsStatic);
        Assert.DoesNotContain(globalScope.Diagnostics, d => d.Id is "GS0325" or "GS0593" or "GS0594" or "GS0595" or "GS0596");

        var emitDiagnostics = GetEmitDiagnostics(source);
        Assert.DoesNotContain(emitDiagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void InstanceGeneratedRegex_BindsAndAttachesMetadata_NoErrors()
    {
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    @GeneratedRegex(""^[a-z]+$"")
    public func LowercaseWords() Regex;
}
";
        var globalScope = BindSource(source);
        var structSym = globalScope.Structs.Single(s => s.Name == "C");
        var method = structSym.Methods.Single(m => m.Name == "LowercaseWords");

        Assert.True(method.IsGeneratedRegex);
        Assert.False(method.IsAbstract);
        Assert.NotNull(method.GeneratedRegexMetadata);
        Assert.NotNull(method.GeneratedRegexBackingField);
        Assert.True(method.GeneratedRegexBackingField.IsStatic);
        Assert.DoesNotContain(globalScope.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);

        var emitDiagnostics = GetEmitDiagnostics(source);
        Assert.DoesNotContain(emitDiagnostics, d => d.Severity == DiagnosticSeverity.Error);
    }

    [Fact]
    public void MissingPattern_ReportsGS0593()
    {
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0593");
    }

    [Fact]
    public void ParametersOnGeneratedRegexFunction_ReportsGS0594()
    {
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""^[a-z]+$"")
        func Pattern(x int32) Regex;
    }
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0594");
    }

    [Fact]
    public void NonNumericStringOptionsArgument_ReportsGS0594_DoesNotThrow()
    {
        // Issue #4301 review: `Convert.ToInt32("bogus")` throws an uncaught
        // FormatException out of the binder for exactly this shape (a
        // plausible user typo, e.g. swapped argument order). BindSource
        // itself must not throw — a malformed `options` argument is a
        // diagnostic, never a compiler crash.
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""^[a-z]+$"", ""bogus"")
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0594");
        var structSym = globalScope.Structs.Single(s => s.Name == "C");
        var method = structSym.StaticMethods.Single(m => m.Name == "Pattern");
        Assert.False(method.IsGeneratedRegex);
    }

    [Fact]
    public void BoolOptionsArgument_ReportsGS0594_DoesNotSilentlyBecomeIgnoreCase()
    {
        // Issue #4301 review: `Convert.ToInt32(true)` returns 1, which is
        // exactly RegexOptions.IgnoreCase's bit value — a convertible-but-
        // wrong-typed argument must not silently miscompile into an
        // arbitrary RegexOptions combination with no diagnostic at all.
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""^[a-z]+$"", true)
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0594");
        var structSym = globalScope.Structs.Single(s => s.Name == "C");
        var method = structSym.StaticMethods.Single(m => m.Name == "Pattern");
        Assert.False(method.IsGeneratedRegex);
    }

    [Fact]
    public void BoolNamedOptionsArgument_ReportsGS0594()
    {
        // Same as above, but through the named-argument ("options:") path
        // rather than the positional one — both call sites in
        // GeneratedRegexBinder must validate.
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""^[a-z]+$"", options: true)
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0594");
    }

    [Fact]
    public void WrongReturnType_ReportsGS0594()
    {
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""^[a-z]+$"")
        func Pattern() string;
    }
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0594");
    }

    [Fact]
    public void IgnoreCaseWithoutCultureInvariant_ReportsGS0595()
    {
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""^[a-z]+$"", RegexOptions.IgnoreCase)
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0595");
    }

    [Fact]
    public void IgnoreCaseWithCultureInvariant_DoesNotReportGS0595()
    {
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""^[a-z]+$"", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant)
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        Assert.DoesNotContain(globalScope.Diagnostics, d => d.Id == "GS0595");
    }

    [Fact]
    public void InlineIgnoreCaseGroup_WithoutCultureInvariant_ReportsGS0595()
    {
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""(?i)^abc$"")
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0595");
    }

    [Fact]
    public void InvalidOptionsCombination_ReportsGS0596()
    {
        // ECMAScript combined with Singleline is not a legal RegexOptions
        // combination (mirrors Regex's own ValidateOptions).
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""^[a-z]+$"", RegexOptions.ECMAScript | RegexOptions.Singleline)
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0596");
    }

    [Fact]
    public void NonConstantPattern_ReportsGS0593()
    {
        // Issue #4301: a non-constant `pattern` argument (here, a call whose
        // result is not foldable to a compile-time constant) fails the
        // generic attribute-argument constant check first (GS0202-ish), and
        // — since no positional argument was accepted at all — also reports
        // GS0593 ("requires a non-empty constant string").
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        func GetPattern() string {
            return ""^[a-z]+$""
        }

        @GeneratedRegex(GetPattern())
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0593");
    }

    [Fact]
    public void NegativeOneTimeout_BindsWithNoErrorDiagnostics()
    {
        // Issue #4301 / Cs2Gs.Tests Issue3086GeneratedRegex fixture's
        // `InfinitePattern`: -1 denotes Regex.InfiniteMatchTimeout and must
        // bind (and construct-probe) cleanly, not just "anything other than
        // -2".
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""^infinite$"", RegexOptions.None, matchTimeoutMilliseconds: -1)
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        Assert.DoesNotContain(globalScope.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        var structSym = globalScope.Structs.Single(s => s.Name == "C");
        var method = structSym.StaticMethods.Single(m => m.Name == "Pattern");
        Assert.True(method.GeneratedRegexMetadata!.HasMatchTimeout);
        Assert.Equal(-1, method.GeneratedRegexMetadata.MatchTimeoutMilliseconds);
    }

    [Fact]
    public void MatchTimeoutMilliseconds_NamedArgument_Binds()
    {
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""^[a-z]+$"", RegexOptions.None, matchTimeoutMilliseconds: 1000)
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        var structSym = globalScope.Structs.Single(s => s.Name == "C");
        var method = structSym.StaticMethods.Single(m => m.Name == "Pattern");
        Assert.DoesNotContain(globalScope.Diagnostics, d => d.Severity == DiagnosticSeverity.Error);
        Assert.True(method.GeneratedRegexMetadata!.HasMatchTimeout);
        Assert.Equal(1000, method.GeneratedRegexMetadata.MatchTimeoutMilliseconds);
    }

    [Fact]
    public void NegativeTimeoutOtherThanInfinite_ReportsGS0596()
    {
        const string source = @"
package p
import System.Text.RegularExpressions

class C {
    shared {
        @GeneratedRegex(""^[a-z]+$"", RegexOptions.None, matchTimeoutMilliseconds: -2)
        func Pattern() Regex;
    }
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0596");
    }

    [Fact]
    public void BodylessInstanceFunc_WithoutRecognizedAttribute_StillReportsAbstractMethodRequiresOpenClass()
    {
        // Regression: reordering attribute binding ahead of the
        // abstract-method / semicolon-body check (to see @GeneratedRegex in
        // time) must not change behavior for an ordinary bodyless instance
        // method with no recognised discriminator attribute.
        const string source = @"
package p
class C {
    func F() int32;
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0388");
    }

    [Fact]
    public void BodylessStaticFunc_WithoutRecognizedAttribute_StillReportsGS0325()
    {
        const string source = @"
package p
class C {
    shared {
        func F() int32;
    }
}
";
        var globalScope = BindSource(source);
        Assert.Contains(globalScope.Diagnostics, d => d.Id == "GS0325");
    }

    private static BoundGlobalScope BindSource(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        return Binder.BindGlobalScope(previous: null, ImmutableArray.Create(tree));
    }

    private static IEnumerable<Diagnostic> GetEmitDiagnostics(string source)
    {
        var tree = SyntaxTree.Parse(SourceText.From(source));
        var compilation = new GSharp.Core.CodeAnalysis.Compilation.Compilation(tree);
        using var peStream = new MemoryStream();
        return compilation.Emit(peStream).Diagnostics;
    }
}
