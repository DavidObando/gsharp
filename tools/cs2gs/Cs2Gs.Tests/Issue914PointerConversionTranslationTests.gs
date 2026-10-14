// <copyright file="Issue914PointerConversionTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.CodeModel.RoundTrip
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import System
import Xunit

/// Issue #914: in C# a pointer→pointer conversion between different pointee
/// types (`byte* → void*`) is IMPLICIT, but per ADR-0122 §6 G# requires
/// it to be spelled explicitly as the conversion-call `*<TargetPointee>(expr)`
/// (`*void(expr)`, `*uint8(expr)`). Emitting the bare operand fails
/// gsc with GS0156 ("An explicit conversion exists"). These tests cover the
/// implicit conversion at argument, assignment, return, and local-initializer
/// positions, verify a same-pointee argument is NOT wrapped, and verify an
/// already-explicit C# cast is not double-wrapped.
open class Issue914PointerConversionTranslationTests {
    @Fact
    func ImplicitBytePtrToVoidPtr_Argument_EmitsExplicitConversion() {
        let rendered = Render(`
namespace Corpus.Issue914
{
    public static unsafe class Holder
    {
        public static void Sink(void* p) { }

        public static void Pass(byte* pBuf)
        {
            Sink(pBuf);
        }
    }
}
`)
        Assert.Contains("Sink(*void(pBuf))", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ImplicitBytePtrToVoidPtr_Assignment_EmitsExplicitConversion() {
        let rendered = Render(`
namespace Corpus.Issue914
{
    public static unsafe class Holder
    {
        public static void Assign(byte* p)
        {
            void* q = null;
            q = p;
        }
    }
}
`)
        Assert.Contains("q = *void(p)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ImplicitIntPtrToVoidPtr_Return_EmitsExplicitConversion() {
        let rendered = Render(`
namespace Corpus.Issue914
{
    public static unsafe class Holder
    {
        public static void* Widen(int* p)
        {
            return p;
        }
    }
}
`)
        Assert.Contains("return *void(p)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ImplicitBytePtrToVoidPtr_LocalInitializer_EmitsExplicitConversion() {
        let rendered = Render(`
namespace Corpus.Issue914
{
    public static unsafe class Holder
    {
        public static void Init(byte* pBuf)
        {
            void* p = pBuf;
        }
    }
}
`)
        Assert.Contains("*void(pBuf)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func SamePointeeArgument_IsNotWrapped() {
        // `void* → void*` needs no conversion; the argument must stay bare.
        let rendered = Render(`
namespace Corpus.Issue914
{
    public static unsafe class Holder
    {
        public static void Sink(void* p) { }

        public static void Pass(void* pBuffer)
        {
            Sink(pBuffer);
        }
    }
}
`)
        Assert.Contains("Sink(pBuffer)", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("*void(pBuffer)", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    @Fact
    func ExplicitCastArgument_IsNotDoubleWrapped() {
        // An explicit C# `(void*)pBuf` already renders as `*void(pBuf)`; the
        // implicit-conversion pass must not wrap it again.
        let rendered = Render(`
namespace Corpus.Issue914
{
    public static unsafe class Holder
    {
        public static void Sink(void* p) { }

        public static void Pass(byte* pBuf)
        {
            Sink((void*)pBuf);
        }
    }
}
`)
        Assert.Contains("Sink(*void(pBuf))", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("*void(*void(pBuf))", rendered, StringComparison.Ordinal)
        AssertRoundTripParses(rendered)
    }

    shared {
        private func AssertRoundTripParses(rendered string) {
            let result RoundTripResult? = TranslationTestValidation.AssertBinds(rendered)
            Assert.True(
                result!!.Success,
                "Sanitized G# must round-trip-parse. Errors:\n" + string.Join("\n", result!!.Errors) + `

Printed:
` + rendered
            )
        }

        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let unit = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> d.Severity == TranslationSeverity.Unsupported
            )
            return GSharpPrinter.Print(unit)
        }
    }
}
