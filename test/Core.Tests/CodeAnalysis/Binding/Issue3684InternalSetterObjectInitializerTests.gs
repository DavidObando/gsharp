// <copyright file="Issue3684InternalSetterObjectInitializerTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.IO
import System.Linq
import System.Text
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import GSharp.Core.CodeAnalysis

/// Issue #3684 (family F7): an object initializer must honour a friend-visible
/// `internal` setter of a referenced assembly's property.
///
/// #3693 taught the CLR instance-call and imported-static probes to admit
/// `assembly` accessibility when the declaring assembly names this
/// compilation in an `InternalsVisibleTo`. The object-initializer member
/// path kept its own writability test — `GetSetMethod(nonPublic: false)`
/// — so `{ get; internal set; }` still reported GS0127 "read-only and
/// cannot be assigned to" across a friend boundary. Only `assembly`
/// accessibility is admitted: `private`, `protected` and
/// `private protected` setters stay rejected however the friendship is
/// declared, and a non-friend consumer sees none of them.
class Issue3684InternalSetterObjectInitializerTests {
    @Fact
    func FriendAssembly_ObjectInitializer_Assigns_Internal_Setter() {
        RunFriend(
            "Restricted",
            (result Issue3684InternalSetterObjectInitializerTests.CompileResult) -> {
                Assert.True(result.Success, Describe(result))
                // Binding alone is not the contract: the emitted body must
                // actually CALL the internal accessor, not silently drop the
                // member. The setter's name is interned in the image's string
                // heap by the memberref the assignment emits.
                Assert.Contains("set_Restricted", Encoding.UTF8.GetString(result.Image), StringComparison.Ordinal)
            }
        )
    }

    /// The same widening on the PLAIN assignment path — a friend writing
    /// `bag.Restricted = 1` — which shares the binder's writability test
    /// with the object-initializer path and was equally rejected.
    @Fact
    func FriendAssembly_Assignment_Writes_Internal_Setter() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", CSharpLibrarySource)
            let result = CompileGSharp(`package Issue3684.Friend
import Issue3684.Library

func Run() Bag {
    let bag = Bag()
    bag.Restricted = 1
    return bag
}`, "Issue3684.Friend", libraryPath)
            Assert.True(result.Success, Describe(result))
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// The plain-assignment counterpart of the accessibility guard: a
    /// `private` setter is not writable even for a friend.
    @Fact
    func FriendAssembly_Assignment_Still_Rejects_Private_Setter() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", CSharpLibrarySource)
            let result = CompileGSharp(`package Issue3684.Friend
import Issue3684.Library

func Run() Bag {
    let bag = Bag()
    bag.Secret = 1
    return bag
}`, "Issue3684.Friend", libraryPath)
            Assert.False(result.Success, Describe(result))
            Assert.Contains(
                result.Diagnostics,
                (d Issue3684InternalSetterObjectInitializerTests.DiagnosticInfo) -> d.Id == "GS0127"
            )
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    @Fact
    func FriendAssembly_ObjectInitializer_Assigns_Public_Setter() {
        RunFriend(
            "Open",
            (result Issue3684InternalSetterObjectInitializerTests.CompileResult) -> Assert.True(
                result.Success,
                Describe(result)
            )
        )
    }

    @Fact
    func FriendAssembly_ObjectInitializer_Still_Rejects_Private_Setter() {
        RunFriend(
            "Secret",
            (result Issue3684InternalSetterObjectInitializerTests.CompileResult) -> {
                Assert.False(result.Success, Describe(result))
                Assert.Contains(
                    result.Diagnostics,
                    (d Issue3684InternalSetterObjectInitializerTests.DiagnosticInfo) -> d.Id == "GS0127"
                )
            }
        )
    }

    @Fact
    func FriendAssembly_ObjectInitializer_Still_Rejects_Protected_Setter() {
        RunFriend(
            "Guarded",
            (result Issue3684InternalSetterObjectInitializerTests.CompileResult) -> {
                Assert.False(result.Success, Describe(result))
                Assert.Contains(
                    result.Diagnostics,
                    (d Issue3684InternalSetterObjectInitializerTests.DiagnosticInfo) -> d.Id == "GS0127"
                )
            }
        )
    }

    /// An object initializer must also find a friend assembly's wholly
    /// `internal` property or field, not only an `internal` setter on
    /// a public property. The member lookup was public-only, so the migrated
    /// `Cs2Gs.Tests` failed on
    /// `PipelineOptions{…, RepositoryAdditionalFiles: …}` (GS0158) even
    /// though `options.RepositoryAdditionalFiles = …` bound.
    /// @param memberName The internal property or field.
    @Theory
    @InlineData("Hidden")
    @InlineData("hiddenField")
    func FriendAssembly_ObjectInitializer_Finds_Internal_Member(memberName string) {
        RunFriend(
            memberName,
            (result Issue3684InternalSetterObjectInitializerTests.CompileResult) -> Assert.True(
                result.Success,
                Describe(result)
            )
        )
    }

    /// The same internal members stay invisible to an assembly the library
    /// did not befriend.
    /// @param memberName The internal property or field.
    @Theory
    @InlineData("Hidden")
    @InlineData("hiddenField")
    func NonFriendAssembly_ObjectInitializer_Does_Not_Find_Internal_Member(memberName string) {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", CSharpLibrarySource)
            let result = CompileGSharp(Consumer("Issue3684.Stranger", memberName), "Issue3684.Stranger", libraryPath)
            Assert.False(result.Success, Describe(result))
            Assert.Contains(
                result.Diagnostics,
                (d Issue3684InternalSetterObjectInitializerTests.DiagnosticInfo) -> d.Id == "GS0158"
            )
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// `private protected` needs a derived type as well as the friend
    /// assembly, so, as in C#, a non-derived friend's object initializer
    /// cannot see it.
    @Fact
    func FriendAssembly_ObjectInitializer_Does_Not_Find_PrivateProtected_Member() {
        RunFriend(
            "ProtectedAndFriend",
            (result Issue3684InternalSetterObjectInitializerTests.CompileResult) -> {
                Assert.False(result.Success, Describe(result))
                Assert.Contains(
                    result.Diagnostics,
                    (d Issue3684InternalSetterObjectInitializerTests.DiagnosticInfo) -> d.Id == "GS0158"
                )
            }
        )
    }

    /// `protected internal` is accessible to a friend assembly in C#. The
    /// object initializer must agree with gsc's plain assignment
    /// (`bag.X = 1`); the two paths must never disagree.
    @Fact
    func FriendAssembly_ProtectedInternal_ObjectInitializer_Agrees_With_Assignment() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", CSharpLibrarySource)
            let initializer = CompileGSharp(
                Consumer("Issue3684.Friend", "ProtectedOrFriend"),
                "Issue3684.Friend",
                libraryPath
            )
            let assignment = CompileGSharp(`package Issue3684.Friend
import Issue3684.Library

func Run() Bag {
    let bag = Bag()
    bag.ProtectedOrFriend = 1
    return bag
}`, "Issue3684.Friend", libraryPath)
            Assert.True(
                assignment.Success == initializer.Success,
                "assignment: " + Describe(assignment) + "\ninitializer: " + Describe(initializer)
            )
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// A friend's widened lookup must not let an inaccessible `private`
    /// member of a derived type hide a same-named public base member: the
    /// initializer binds the public `ShadowBase.Shadow`, as plain
    /// assignment does.
    @Fact
    func FriendAssembly_ObjectInitializer_Private_Derived_Member_Does_Not_Hide_Public_Base_Member() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", CSharpLibrarySource)
            let result = CompileGSharp(`package Issue3684.Friend
import Issue3684.Library

func Run() ShadowDerived {
    return ShadowDerived{Shadow: 1}
}`, "Issue3684.Friend", libraryPath)
            Assert.True(result.Success, Describe(result))
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    @Fact
    func NonFriendAssembly_ObjectInitializer_Still_Rejects_Internal_Setter() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", CSharpLibrarySource)
            let result = CompileGSharp(Consumer("Issue3684.Stranger", "Restricted"), "Issue3684.Stranger", libraryPath)
            Assert.False(result.Success, Describe(result))
            Assert.Contains(
                result.Diagnostics,
                (d Issue3684InternalSetterObjectInitializerTests.DiagnosticInfo) -> d.Id == "GS0127"
            )
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// The shape #3684 actually hit: FOUR initializer members in one literal,
    /// every one of them `{ get; internal set; }`. Every member must bind;
    /// the original defect reported on some and not others purely because the
    /// binder's per-member fallbacks differ.
    @Fact
    func FriendAssembly_ObjectInitializer_Assigns_Every_Internal_Setter_In_One_Literal() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", MultiMemberLibrarySource)
            let result = CompileGSharp(`package Issue3684.Friend
import Issue3684.Library
import System.Collections.Immutable

func Run(source Program) Program {
    return Program{
        Imports: source.Imports,
        FriendAssemblies: source.FriendAssemblies,
        AssemblyAttributes: source.AssemblyAttributes,
        ModuleAttributes: source.ModuleAttributes,
    }
}`, "Issue3684.Friend", libraryPath)
            Assert.True(result.Success, Describe(result))
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// The literal spelling the migrated `test/Core.Tests` carries: cs2gs
    /// renders a C# object initializer with `=` and a trailing constructor
    /// argument list — `T(args){A = x, B = y}` — which is why the reported
    /// GS0127 locations in #3684 sit on the `=` tokens rather than the member
    /// names. Every member must bind.
    @Fact
    func FriendAssembly_EqualsSpelledInitializer_Assigns_Every_Internal_Setter() {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", MultiMemberLibrarySource)
            let result = CompileGSharp(`package Issue3684.Friend
import Issue3684.Library
import System.Collections.Immutable

func Run(source Program) Program {
    return Program(){
        Imports = source.Imports,
        FriendAssemblies = source.FriendAssemblies,
        AssemblyAttributes = source.AssemblyAttributes,
        ModuleAttributes = source.ModuleAttributes}
}`, "Issue3684.Friend", libraryPath)
            Assert.True(result.Success, Describe(result))
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    private data struct CompileResult(
        Success bool,
        Diagnostics[]Issue3684InternalSetterObjectInitializerTests.DiagnosticInfo,
        Image[]uint8
    ) : IEquatable[Issue3684InternalSetterObjectInitializerTests.CompileResult] { }

    private data struct DiagnosticInfo(Id string, Message string?) : IEquatable[
        Issue3684InternalSetterObjectInitializerTests.DiagnosticInfo
    ] { }

    shared {
        private const CSharpLibrarySource string = `using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Issue3684.Friend")]

namespace Issue3684.Library;

public class Bag
{
    public int Open { get; set; }

    public int Restricted { get; internal set; }

    public int Secret { get; private set; }

    public int Guarded { get; protected set; }

    internal int Hidden { get; set; }

    internal int hiddenField;

    protected internal int ProtectedOrFriend { get; set; }

    private protected int ProtectedAndFriend { get; set; }
}

public class ShadowBase
{
    public int Shadow { get; set; }
}

public class ShadowDerived : ShadowBase
{
    private new int Shadow { get; set; }
}`

        /// The exact shape #3684 hit: FOUR members in one literal, every one of
        /// them `{ get; internal set; }` — modelled on `BoundProgram`'s
        /// `Imports` / `FriendAssemblies` / `AssemblyAttributes` /
        /// `ModuleAttributes`.
        private const MultiMemberLibrarySource string = `using System.Collections.Immutable;
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Issue3684.Friend")]

namespace Issue3684.Library;

public class Program
{
    public ImmutableArray<string> Imports { get; internal set; } = ImmutableArray<string>.Empty;

    public ImmutableArray<string> FriendAssemblies { get; internal set; } = ImmutableArray<string>.Empty;

    public ImmutableArray<string> AssemblyAttributes { get; internal set; } = ImmutableArray<string>.Empty;

    public ImmutableArray<string> ModuleAttributes { get; internal set; } = ImmutableArray<string>.Empty;
}`

        private func Consumer(assemblyName string, memberName string) string -> (`package ` + "$assemblyName" + `
import Issue3684.Library

func Run() Bag {
    return Bag{` + "$memberName" + `: 1}
}`)

        private func RunFriend(
            memberName string,
            assert(Issue3684InternalSetterObjectInitializerTests.CompileResult) -> void
        ) {
            let directory = CreateOutputDirectory()
            try {
                let libraryPath = EmitCSharpLibrary(directory, "Issue3684.Library", CSharpLibrarySource)
                assert(CompileGSharp(Consumer("Issue3684.Friend", memberName), "Issue3684.Friend", libraryPath))
            } finally {
                DeleteOutputDirectory(directory)
            }
        }

        private func Describe(result Issue3684InternalSetterObjectInitializerTests.CompileResult) string -> string.Join(
            Environment.NewLine,
            result.Diagnostics.Select(
                (d Issue3684InternalSetterObjectInitializerTests.DiagnosticInfo) -> d.Id + ": " + d.Message
            )
        )

        private func CompileGSharp(
            source string,
            assemblyName string,
            references ...string
        ) Issue3684InternalSetterObjectInitializerTests
            .CompileResult {
            using let resolver = if references.Length == 0 {
                ReferenceResolver.Default()
            } else {
                ReferenceResolver.WithReferences(references)
            }
            resolver.CurrentAssemblyName = assemblyName
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){
                AssemblyName = assemblyName
            }
            using let output = MemoryStream()
            let emit = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
            return Issue3684InternalSetterObjectInitializerTests.CompileResult(
                emit.Success,
                emit
                    .Diagnostics
                    .Select(
                    (
                        d GSharp.Core.CodeAnalysis.Diagnostic
                    ) -> Issue3684InternalSetterObjectInitializerTests.DiagnosticInfo(d.Id, d.Message)
                )
                    .ToArray(),
                output.ToArray()
            )
        }

        private func EmitCSharpLibrary(directory string, assemblyName string, source string) string {
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists).Select(
                (path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path))
            )
            let compilation = CSharpCompilation.Create(
                assemblyName,
                []Microsoft
                    .CodeAnalysis
                    .SyntaxTree{CSharpSyntaxTree.ParseText(source, CSharpParseOptions(LanguageVersion.Latest))},
                references,
                CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
            )
            let path = Path.Combine(directory, assemblyName + ".dll")
            using let output = File.Create(path)
            let emit = compilation.Emit(output)
            Assert.True(emit.Success, string.Join(Environment.NewLine, emit.Diagnostics))
            return path
        }

        private func CreateOutputDirectory() string {
            let directory = Path.Combine(
                AppContext.BaseDirectory,
                "Issue3684InternalSetterObjectInitializerTests",
                Guid.NewGuid().ToString("N")
            )
            Directory.CreateDirectory(directory)
            return directory
        }

        private func DeleteOutputDirectory(directory string) {
            try {
                Directory.Delete(directory, recursive: true)
            } catch (IOException) { }
        }
    }
}
