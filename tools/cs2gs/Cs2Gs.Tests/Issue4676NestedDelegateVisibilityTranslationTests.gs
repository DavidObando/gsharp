// <copyright file="Issue4676NestedDelegateVisibilityTranslationTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package Cs2Gs.Tests

import Cs2Gs.CodeModel.Ast
import Cs2Gs.CodeModel.Printing
import Cs2Gs.Pipeline
import Cs2Gs.Translator
import Cs2Gs.Translator.Loading
import GSharp.Tests
import System
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #4676: G# named delegates are top-level only, so cs2gs lifts a nested C#
/// delegate (`Outer_NameDelegate`). It lifted a `public` delegate nested
/// in an `internal` class as `public`, publishing four types the C#
/// GSharp.Core never exported (`OverloadResolver.TryBindClrConstructorCallDelegate`
/// and its three siblings, nested in the internal `OverloadResolver`). The
/// lifted delegate's visibility is now bounded by every type that encloses it.
open class Issue4676NestedDelegateVisibilityTranslationTests {
    @Theory
    @InlineData("OverloadResolver_TryBindDelegate", Visibility(2))
    @InlineData("OverloadResolver_InternalDelegate", Visibility(2))
    @InlineData("OverloadResolver_PrivateDelegate", Visibility(2))
    @InlineData("PublicHost_Reachable", Visibility(0))
    @InlineData("PublicHost_Friend", Visibility(2))
    @InlineData("PublicHost_Hidden", Visibility(2))
    @InlineData("PublicHost_Derived", Visibility(2))
    @InlineData("PublicHost_DerivedOrFriend", Visibility(2))
    @InlineData("TopLevel", Visibility(0))
    func LiftedDelegate_VisibilityIsBoundedByItsContainers(name string, expected Visibility) {
        // A lifted delegate has no container left to be `protected` in (a top-level
        // `protected` is GS0380), so a protected one is internal too.
        let lifted = LiftedDelegates().Single((d NamedDelegateDeclaration) -> d.Name == name)
        Assert.Equal(expected, lifted.Visibility)
    }

    @Fact
    func LiftedDelegate_NestedTwoDeepInPublicTypes_StaysReachable_AndInInternalTypes_DoesNot() {
        let delegates = LiftedDelegates()
        Assert.Equal(
            Visibility.Default,
            delegates.Single((d NamedDelegateDeclaration) -> d.Name.Contains("DeepReachable", StringComparison.Ordinal))
                .Visibility
        )
        Assert.Equal(
            Visibility.Internal,
            delegates.Single((d NamedDelegateDeclaration) -> d.Name.Contains("DeepHidden", StringComparison.Ordinal))
                .Visibility
        )
    }

    @Fact
    func Rendered_InternalHostDelegate_IsNotPublic() {
        let rendered = GSharpPrinter.Print(Translate())
        Assert.Contains("internal delegate OverloadResolver_TryBindDelegate", rendered, StringComparison.Ordinal)
        Assert.DoesNotContain("\ndelegate OverloadResolver_TryBindDelegate", rendered, StringComparison.Ordinal)
        Assert.Contains("\ndelegate PublicHost_Reachable", rendered, StringComparison.Ordinal)
    }

    @Theory
    @InlineData("public", TypeAttributes(1))
    @InlineData("protected", TypeAttributes(0))
    @InlineData("protected internal", TypeAttributes(0))
    @InlineData("internal", TypeAttributes(0))
    @InlineData("private", TypeAttributes(0))
    func LiftedDelegates_CompileAndRun_WithExactVisibilityAndSignatures(
        containerVisibility string,
        expectedVisibility TypeAttributes
    ) {
        let source = (`using System;

namespace Corpus.Issue4676
{
    public class Outer
    {
        ` + "$containerVisibility" + ` class Inner
        {
            public delegate int D(int value);
            public delegate T Identity<T>(T value);
            internal delegate int Friend(int value);
            private delegate int Hidden(int value);
            protected delegate int Derived(int value);
            protected internal delegate int DerivedOrFriend(int value);

            public class Middle
            {
                public class Leaf
                {
                    public delegate int Deep(int value);

                    public static int Run()
                    {
                        Deep d = x => x + 3;
                        return d(39);
                    }
                }
            }

            public static int Run()
            {
                D d = x => x + 1;
                Friend f = x => x + 1;
                Hidden h = x => x + 1;
                Derived p = x => x + 1;
                DerivedOrFriend q = x => x + 1;
                Identity<int> i = x => x;
                return i(q(p(h(f(d(37))))));
            }
        }

        public static int Run() => Inner.Run() + Inner.Middle.Leaf.Run();

        public static Type DelegateType() => typeof(Inner.D);
    }

    ` + "${(if containerVisibility == "private" { "" } else { `public sealed class Child : Outer
{
    public static int RunDerived() => Inner.Run() + Inner.Middle.Leaf.Run();
}` })}" + `
}`)
        let project = Load(source)
        using let csharpImage = MemoryStream()
        let csharpEmit = project.Compilation.Emit(csharpImage)
        Assert.True(csharpEmit.Success, string.Join(Environment.NewLine, csharpEmit.Diagnostics))
        let original = EmittedFixture.Load(csharpImage.ToArray())
        let originalDelegate = Assert.IsAssignableFrom[Type](Invoke(original, "Outer", "DelegateType"))
        Assert.Equal(expectedVisibility == TypeAttributes.Public, originalDelegate.IsVisible)
        Assert.Equal(84, Invoke(original, "Outer", "Run"))
        if containerVisibility != "private" {
            Assert.Equal(84, Invoke(original, "Child", "RunDerived"))
        }
        // Validate and emit the C# fixture before translating it: these are legal
        // inside-owner/derived uses, not inaccessible source or ambient test types.
        let printed = GSharpPrinter.Print(Translate(project))
        let compiler string? = GscInvoker.Resolve(nil, "Release", AppContext.BaseDirectory)
        Assert.NotNull(compiler)
        let directory = Directory.CreateTempSubdirectory("gs_issue4676_delegates_").FullName
        try {
            let sourcePath = Path.Combine(directory, "Delegates.gs")
            let assemblyPath = Path.Combine(directory, "Delegates.dll")
            File.WriteAllText(sourcePath, printed)
            let compiled = GscInvoker(compiler!!).Compile(
                []string{sourcePath},
                assemblyPath,
                TargetKind.Library,
                Array.Empty[string]()
            )
            Assert.True(compiled.ExitCode == 0, compiled.Output + Environment.NewLine + printed)
            Assert.True(File.Exists(assemblyPath), compiled.Output)
            let translated = EmittedFixture.Load(assemblyPath)
            let delegates = translated
                .GetTypes()
                .Where((type Type) -> type.BaseType == typeof(MulticastDelegate))
                .OrderBy((type Type) -> type.FullName!!, StringComparer.Ordinal)
                .ToArray()
            let names[]string = []string{
                "Corpus.Issue4676.Outer_Inner_D",
                "Corpus.Issue4676.Outer_Inner_Derived",
                "Corpus.Issue4676.Outer_Inner_DerivedOrFriend",
                "Corpus.Issue4676.Outer_Inner_Friend",
                "Corpus.Issue4676.Outer_Inner_Hidden",
                "Corpus.Issue4676.Outer_Inner_Identity`1",
                "Corpus.Issue4676.Outer_Inner_Middle_Leaf_Deep"
            }
            Assert.Equal(names, delegates.Select((type Type) -> type.FullName))
            for type in delegates {
                let publicDeclaration = (
                    type.Name is "Outer_Inner_D" or "Outer_Inner_Identity`1" or "Outer_Inner_Middle_Leaf_Deep"
                )
                Assert.Equal(
                    if publicDeclaration {
                        expectedVisibility
                    } else {
                        TypeAttributes.NotPublic
                    },
                    type.Attributes & TypeAttributes.VisibilityMask
                )
                let constructed = if type.IsGenericTypeDefinition {
                    type.MakeGenericType(typeof(int32))
                } else {
                    type
                }
                let invoke MethodInfo? = constructed.GetMethod("Invoke")
                Assert.NotNull(invoke)
                Assert.Equal(typeof(int32), invoke!!.ReturnType)
                Assert.Equal(typeof(int32), Assert.Single(invoke!!.GetParameters()).ParameterType)
                Assert.Equal("value", Assert.Single(invoke!!.GetParameters()).Name)
            }
            Assert.Equal(
                if expectedVisibility == TypeAttributes.Public {
                    []string{names[0], names[5], names[6]}
                } else {
                    Array.Empty[string]()
                },
                translated
                    .GetExportedTypes()
                    .Where((type Type) -> type.BaseType == typeof(MulticastDelegate))
                    .Select((type Type) -> type.FullName!!)
                    .OrderBy((name string) -> name, StringComparer.Ordinal)
            )
            Assert.Equal(delegates[0], Invoke(translated, "Outer", "DelegateType"))
            Assert.Equal(84, Invoke(translated, "Outer", "Run"))
            if containerVisibility != "private" {
                Assert.Equal(84, Invoke(translated, "Child", "RunDerived"))
            }
        } finally {
            Directory.Delete(directory, recursive: true)
        }
    }

    shared {
        private const Source string = `
namespace Corpus.Issue4676
{
    internal sealed class OverloadResolver
    {
        public delegate bool TryBindDelegate(int syntax, out string result);

        internal delegate void InternalDelegate();

        private delegate void PrivateDelegate();
    }

    public sealed class PublicHost
    {
        public delegate bool Reachable(int x);

        internal delegate bool Friend(int x);

        private delegate bool Hidden(int x);

        protected delegate bool Derived(int x);

        protected internal delegate bool DerivedOrFriend(int x);

        public sealed class Inner
        {
            public delegate void DeepReachable();
        }
    }

    internal sealed class InternalHost
    {
        public sealed class Inner
        {
            public delegate void DeepHidden();
        }
    }

    public delegate void TopLevel();
}
`

        private func Invoke(assembly Assembly, typeName string, methodName string) object? {
            let type Type? = assembly.GetType("Corpus.Issue4676." + typeName)
            Assert.NotNull(type)
            let method MethodInfo? = type!!.GetMethod(methodName, BindingFlags.Public | BindingFlags.Static)
            Assert.NotNull(method)
            return method!!.Invoke(nil, nil)
        }

        private func LiftedDelegates()[]NamedDelegateDeclaration -> Translate()
            .Members
            .OfType[NamedDelegateDeclaration]()
            .ToArray()

        private func Load(source string) LoadedCSharpProject {
            let project = CSharpProjectLoader.LoadInMemory([](string, source string){("Delegates.cs", source)})
            Assert.True(
                project.BoundWithoutErrors,
                "inline source should bind with no C# errors: " + string.Join(
                    Environment.NewLine,
                    project.ErrorDiagnostics
                )
            )
            return project
        }

        private func Translate() CompilationUnit -> Translate(Load(Source))

        private func Translate(project LoadedCSharpProject) CompilationUnit {
            let document = Assert.Single(project.Documents)
            let context = TranslationContext(project.Compilation, document.SemanticModel, document.FilePath)
            let translated = CSharpToGSharpTranslator().TranslateDocument(document, context)
            Assert.DoesNotContain(
                context.Diagnostics,
                (diagnostic TranslationDiagnostic) -> diagnostic.Severity == TranslationSeverity.Unsupported
            )
            return translated
        }
    }
}
