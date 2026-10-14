// <copyright file="Issue2443ExternalOverrideTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.IO
import System.Linq
import Xunit

/// Issue #2443: cs2gs must preserve overrides whose root declaration comes
/// from metadata; dropping the modifier silently creates a shadowing member.
class Issue2443ExternalOverrideTranslationTests {
    @Fact
    func MetadataBaseOverrides_ArePrintedForEverySupportedMemberKind() {
        const Source = `using System;
using External2443;

namespace Demo;

public class Derived : ExternalBase<int>
{
    public override string Echo(int value) => value.ToString();

    public sealed override object Identity(object value) => value;

    public override int Value => 7;

    public override int this[int index] => index;

    public override event EventHandler Changed
    {
        add { }
        remove { }
    }
}`
        let printed = Translate(Source)
        Assert.Contains("override func Echo", printed, StringComparison.Ordinal)
        Assert.Contains("override func Identity", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("open override func Identity", printed, StringComparison.Ordinal)
        Assert.Contains("override prop Value", printed, StringComparison.Ordinal)
        Assert.Contains("override prop this[", printed, StringComparison.Ordinal)
        Assert.Contains("override event Changed", printed, StringComparison.Ordinal)
    }

    @Fact
    func BclOverride_IsNotSilentlyLoweredToPlainMethod() {
        const Source = `using System;
using System.Threading;

namespace Demo;

public sealed class Context : SynchronizationContext
{
    public override void Post(SendOrPostCallback callback, object state)
    {
    }
}`
        let printed = Translate(Source, includeExternalBase: false)
        Assert.Contains("override func Post", printed, StringComparison.Ordinal)
        Assert.DoesNotContain("${Environment.NewLine}    func Post", printed, StringComparison.Ordinal)
    }

    shared {
        private func Translate(source string, includeExternalBase bool = true) string {
            let references = CSharpProjectLoader.RuntimeReferences().ToList()
            if includeExternalBase {
                references.Add(BuildExternalBaseReference())
            }
            let project = CSharpProjectLoader.LoadInMemory(
                [](string, source string){("Derived.cs", source)},
                references
            )
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }

        private func BuildExternalBaseReference() MetadataReference {
            const Source = `using System;

namespace External2443;

public class ExternalBase<T>
{
    public virtual T Value => default!;

    public virtual T this[int index] => default!;

    public virtual event EventHandler Changed
    {
        add { }
        remove { }
    }

    public virtual string Echo(T value) => string.Empty;

    public virtual object Identity(object value) => value;
}`
            let compilation = CSharpCompilation.Create(
                "External2443",
                []SyntaxTree{CSharpSyntaxTree.ParseText(Source, CSharpParseOptions(LanguageVersion.Latest))},
                CSharpProjectLoader.RuntimeReferences(),
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            using let stream = MemoryStream()
            let emitResult = compilation.Emit(stream)
            Assert.True(emitResult.Success, string.Join(Environment.NewLine, emitResult.Diagnostics))
            return MetadataReference.CreateFromImage(stream.ToArray())
        }
    }
}
