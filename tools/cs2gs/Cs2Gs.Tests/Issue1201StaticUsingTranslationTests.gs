// <copyright file="Issue1201StaticUsingTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import System.Linq
import Xunit

/// Issue #1201 / ADR-0134: a C# `using static X` translates to a bare type
/// import `import X`, which gsc now hoists X's `shared` (static)
/// members into scope for unqualified reference. So unlike a sibling static
/// (which is qualified through its owning type, see
/// (cref:StaticMemberQualificationTranslationTests)), a member referenced
/// through a `using static` directive must be emitted UNqualified — the
/// pre-fix qualification workaround is removed.
open class Issue1201StaticUsingTranslationTests {
    @Fact
    func UsingStatic_TranslatesTo_BareTypeImport() {
        let rendered = TranslateCaller()
        Assert.Contains("import Corpus.Aux.EnumUtil", rendered, StringComparison.Ordinal)
    }

    @Fact
    func BareStaticCall_ThroughUsingStatic_StaysUnqualified() {
        let rendered = TranslateCaller()
        Assert.Contains("GetValues()", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("EnumUtil.GetValues", rendered, StringComparison.Ordinal)
    }

    @Fact
    func BareGenericStaticCall_ThroughUsingStatic_StaysUnqualified() {
        let rendered = TranslateCaller()
        Assert.Contains("GetValuesOf", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("EnumUtil.GetValuesOf", rendered, StringComparison.Ordinal)
    }

    @Fact
    func BareStaticFieldRef_ThroughUsingStatic_StaysUnqualified() {
        let rendered = TranslateCaller()
        Assert.DoesNotContain("EnumUtil.Answer", rendered, StringComparison.Ordinal)
    }

    /// A `using static` member whose name is also an imported type keeps
    /// its owner qualifier: gsc resolves the bare name to the TYPE, so a bare
    /// `File(x)` would bind as a conversion to `System.IO.File`
    /// (GS0155). C# picks the member in an invocation, so the translation must
    /// spell it out. (A non-invoked reference has no such case: C# itself
    /// reports CS0229 for a member-vs-type ambiguity there.) This is the nightly
    /// self-migration regression in
    /// `GSharp.GeneratorHost.Tests/GeneratedRegexStubTests.cs`.
    @Fact
    func UsingStaticMember_WhoseNameIsAnImportedType_IsQualified() {
        let rendered = Translate(CollidingAuxSource, CollidingCallerSource)
        Assert.Contains("StubSupport.File(", rendered, StringComparison.Ordinal)
        // The explicit-generic form collides with `List[T]` the same way.
        Assert.Contains("StubSupport.List[string](", rendered, StringComparison.Ordinal)
        // No collision, no qualifier: the ADR-0134 bare form is unchanged.
        Assert.Contains("Keep(\"x\")", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("StubSupport.Keep", rendered, StringComparison.Ordinal)
    }

    /// The same rule for a `using static` INTERFACE owner: C# imports an
    /// interface's concrete static methods, and G# spells them as
    /// `shared` interface members, so a colliding call keeps its
    /// qualifier in both the plain and the explicit-generic form.
    @Fact
    func UsingStaticInterfaceMember_WhoseNameIsAnImportedType_IsQualified() {
        let rendered = Translate(CollidingInterfaceAuxSource, CollidingInterfaceCallerSource)
        Assert.Contains("IStubHelpers.File(", rendered, StringComparison.Ordinal)
        Assert.Contains("IStubHelpers.List[string](", rendered, StringComparison.Ordinal)
        Assert.Contains("Keep(\"x\")", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("IStubHelpers.Keep", rendered, StringComparison.Ordinal)
    }

    shared {
        private const AuxSource string = `
namespace Corpus.Aux
{
    public static class EnumUtil
    {
        public static int[] GetValues() => new int[] { 1, 2, 3 };

        public static T[] GetValuesOf<T>(T seed) => new T[] { seed };

        public static readonly int Answer = 42;
    }
}
`

        private const CallerSource string = `
using static Corpus.Aux.EnumUtil;

namespace Corpus.Main
{
    public class Consumer
    {
        public int[] F() => GetValues();

        public string[] G() => GetValuesOf("x");

        public int H() => Answer;
    }
}
`

        private const CollidingAuxSource string = `
namespace Corpus.Aux
{
    public static class StubSupport
    {
        public static string File(string source) => source + "!";

        public static string Keep(string source) => source;

        public static T[] List<T>(T value) => new T[] { value };
    }
}
`

        // `System.IO` is used for real (`Path.GetFileName`), so its import survives
        // and `File` names an imported TYPE at file scope — the shape of
        // GSharp.GeneratorHost.Tests' `using static StubTestSupport` beside
        // `using Microsoft.CodeAnalysis`, whose `Project` type collided with the
        // imported `Project(...)` helper.
        private const CollidingCallerSource string = `
using System.Collections.Generic;
using System.IO;
using static Corpus.Aux.StubSupport;

namespace Corpus.Main
{
    public class Consumer
    {
        public string F() => File(Path.GetFileName("a/b"));

        public string H() => Keep("x");

        public string[] G() => List<string>(new List<string> { "y" }[0]);
    }
}
`

        private const CollidingInterfaceAuxSource string = `
namespace Corpus.Aux
{
    public interface IStubHelpers
    {
        static string File(string source) => source + "!";

        static T[] List<T>(T value) => new T[] { value };

        static string Keep(string source) => source;
    }
}
`

        private const CollidingInterfaceCallerSource string = `
using System.Collections.Generic;
using System.IO;
using static Corpus.Aux.IStubHelpers;

namespace Corpus.Main
{
    public class Consumer
    {
        public string F() => File(Path.GetFileName("a/b"));

        public string[] G() => List<string>(new List<string> { "y" }[0]);

        public string H() => Keep("x");
    }
}
`

        private func TranslateCaller() string -> Translate(AuxSource, CallerSource)

        private func Translate(auxSource string, callerSource string) string {
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, string){("EnumUtil.cs", auxSource), ("Caller.cs", callerSource)}
            )
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = project.Documents.Single(
                (d LoadedDocument) -> d.FilePath.EndsWith("Caller.cs", StringComparison.Ordinal)
            )
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            return GSharpPrinter.Print(unit)
        }
    }
}
