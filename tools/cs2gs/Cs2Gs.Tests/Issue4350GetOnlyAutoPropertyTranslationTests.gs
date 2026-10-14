// <copyright file="Issue4350GetOnlyAutoPropertyTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Printing
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import Xunit

/// Issue #4350: a C# get-only auto-property (`public int Length { get; }`)
/// assigned in its declaring constructor translates to the G# get-only form
/// `prop Length int32 { get; }` — G# now allows that constructor store —
/// instead of `{ get; init; }`, which added a public `init` setter to
/// the migrated assembly's ABI (found by the Gsharp.Runtime.Values ABI
/// comparison: `Slice<T>.Length/Capacity` gained setters).
open class Issue4350GetOnlyAutoPropertyTranslationTests {
    @Fact
    func GetOnlyAutoProperties_KeepGetOnlyShapeAndRun() {
        let printed = Render(`
namespace Corpus.Issue4350
{
    public readonly struct Span2
    {
        public Span2(int length, int capacity)
        {
            Length = length;
            this.Capacity = capacity;
        }

        public int Length { get; }

        public int Capacity { get; }
    }

    public class Named
    {
        public Named(string name)
        {
            Name = name;
            Count += 2;
        }

        public string Name { get; }

        public int Count { get; }

        public string Label { get; } = "label";

        public string Tag { get; init; } = "tag";
    }

    public class Probe
    {
        public static string Run()
        {
            var span = new Span2(3, 8);
            var named = new Named("n");
            return span.Length + "," + span.Capacity + "," + named.Name + named.Count + named.Label + named.Tag;
        }
    }
}
`)
        Assert.Matches("prop Length int32 \\{\\s*get;\\s*\\}", printed)
        Assert.Matches("prop Capacity int32 \\{\\s*get;\\s*\\}", printed)
        Assert.Matches("prop Name string \\{\\s*get;\\s*\\}", printed)
        Assert.Matches("prop Label string \\{\\s*get;\\s*\\}", printed)
        // A real C# `init` accessor stays init-only.
        Assert.Matches("prop Tag string \\{\\s*get;\\s*init;\\s*\\}", printed)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal("3,8,n2labeltag", result.Value)
    }

    @Fact
    func VirtualOverrideAndStaticGetOnlyAutoProperties_LowerToBackingFields() {
        // Review finding (#4350): `{ get; init; }` would add a public write
        // accessor C# never emits. A body-less `open`/`override` `{ get; }` is an
        // abstract slot in G#, and G# has no static-constructor body, so these
        // lower to a private backing field plus an arrow getter, and the
        // constructor/initializer writes target the field.
        let printed = Render(`
namespace Corpus.Issue4350
{
    public class Base
    {
        public Base(int value)
        {
            Value = value;
            Value++;
        }

        public virtual int Value { get; }

        public static int Count { get; } = 3;
    }

    public class Derived : Base
    {
        public Derived(int value) : base(value)
        {
            this.Extra = value * 10;
            this.Extra += 1;
        }

        public override int Value { get; } = 40;

        public virtual int Extra { get; }
    }

    public class Probe
    {
        public static string Run()
        {
            Base b = new Base(5);
            Base d = new Derived(2);
            return b.Value + "," + d.Value + "," + ((Derived)d).Extra + "," + Base.Count;
        }
    }
}
`)
        Assert.DoesNotContain("init;", printed, StringComparison.Ordinal)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal("6,40,21,3", result.Value)
    }

    @Fact
    func LoweredBackingField_AvoidsPrimaryConstructorFieldNames() {
        // Review finding: a constructor write reached before its property must
        // not reserve `_value` when a primary-constructor parameter `_value`
        // becomes a synthesized field of the same name.
        let printed = Render(`
namespace Corpus.Issue4350
{
    public class Holder(int _value)
    {
        public int Seed => _value;

        public virtual int Value { get; } = _value * 2;
    }

    public class Lifted
    {
        private readonly int _value;

        public Lifted(int _value)
        {
            this._value = _value;
            this.Value = _value + 1;
        }

        public int Seed => _value;

        public virtual int Value { get; }
    }

    public class Probe
    {
        public static string Run()
        {
            var holder = new Holder(4);
            var lifted = new Lifted(6);
            return holder.Seed + "," + holder.Value + "," + lifted.Seed + "," + lifted.Value;
        }
    }
}
`)
        Assert.True(TranslationTestValidation.AssertBinds(printed)!!.Success)
        let result = EmittedOracle.Evaluate(printed + Environment.NewLine + "Probe.Run()")
        Assert.Empty(result.Diagnostics)
        Assert.Null(result.UnhandledException)
        Assert.Equal("4,8,6,7", result.Value)
    }

    shared {
        private func Render(source string) string {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Source.cs", source)})
            Assert.True(project.BoundWithoutErrors, string.Join(Environment.NewLine, project.ErrorDiagnostics))
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let printed = GSharpPrinter.Print(CSharpToGSharpTranslator().TranslateDocument(document, context))
            Assert.DoesNotContain(
                context.Diagnostics,
                (d TranslationDiagnostic) -> (
                    d.Severity is TranslationSeverity.Unsupported or TranslationSeverity.Warning
                )
            )
            return printed
        }
    }
}
