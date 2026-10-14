// <copyright file="Issue3705MemberKindAccessibilityDifferentialTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Binding

import System
import System.Collections.Generic
import System.IO
import System.Linq
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Text
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import Xunit
import GSharp.Core.CodeAnalysis

/// Issue #3705: the "inconsistent sibling probe" differential gate.
///
/// Seven defects in one week (#3693, #3702, #3703 ×2, #3680, #3667, #3697)
/// shared one shape — a metadata probe omitting something a sibling probe a
/// few lines away already did. Three of them were literally the same omission
/// found three times: a member-lookup probe that enumerated
/// `BindingFlags.Public` only, so a friend assembly's `internal`
/// member of ONE kind was invisible while the same member of ANOTHER kind
/// resolved fine. Each site looked locally reasonable; only the disagreement
/// between kinds was wrong.
///
/// So rather than one test per site, this fixture asserts the INVARIANT the
/// sites are supposed to share: across method / property / field / event /
/// indexer, read and write, the answer to "can this compilation see the
/// member?" depends only on the member's accessibility and on whether the
/// declaring assembly named this one in an `InternalsVisibleTo` — never
/// on the member's kind. It is issue #3705's prevention option (3), and it
/// fails on `main` for the event, indexer and property/field-write rows
/// while passing for the method and property/field-read rows.
///
/// The guard rails are half the point: outside a derived type,
/// `private` and `protected` stay invisible to a friend, and a
/// non-friend sees neither those nor `internal`. Derived-type probes below
/// separately assert the CLR family-access rules.
class Issue3705MemberKindAccessibilityDifferentialTests {
    @Theory
    @MemberData("Matrix")
    func MemberKinds_Agree_On_FriendAssembly_Visibility(
        kind string,
        accessibility string,
        isFriend bool,
        expectedVisible bool
    ) {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource)
            let consumer = if isFriend {
                FriendAssemblyName
            } else {
                StrangerAssemblyName
            }
            let result = CompileGSharp(BuildSource(kind, accessibility, consumer), consumer, libraryPath)
            if expectedVisible {
                Assert.True(result.Success, "$kind/$accessibility/friend=$isFriend should bind: ${Describe(result)}")
            } else {
                Assert.False(result.Success, "$kind/$accessibility/friend=$isFriend must NOT bind, but it did.")
            }
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// @param name The probe name.
    /// @param body The derived method body.
    /// @param consumer The consuming assembly name.
    /// @param expectedVisible Whether the selected member operation is visible.
    @Theory
    @MemberData("DerivedMemberCases")
    func InheritedMember_Uses_OperationSpecific_Visibility(
        name string,
        body string,
        consumer string,
        expectedVisible bool
    ) {
        let directory = CreateOutputDirectory()
        try {
            let libraryPath = EmitCSharpLibrary(directory, LibraryAssemblyName, CSharpLibrarySource)
            let result = CompileGSharp((`package ` + "$consumer" + `
import Issue3705.Library

class Derived : Surface {
    func Probe() {
        ` + "$body" + `
    }
}`), consumer, libraryPath)
            Assert.True(
                result.Success == expectedVisible,
                "$name: expected visible=$expectedVisible: ${Describe(result)}"
            )
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    /// Friendship belongs to the member's declaring assembly, not the
    /// immediate imported base through which reflection found it.
    @Fact
    func InheritedInternalVisibility_Uses_The_DeclaringAssembly() {
        let directory = CreateOutputDirectory()
        try {
            let friendAncestor = EmitCSharpLibrary(directory, "Issue3705.FriendAncestor", `using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Issue3705.Friend")]
namespace Issue3705.FriendAncestor;
public class Ancestor
{
    internal int ValueField = 1;
    internal int ValueProperty => 2;
}`)
            let neutralMiddle = EmitCSharpLibrary(
                directory,
                "Issue3705.NeutralMiddle",
                "namespace Issue3705.NeutralMiddle;\npublic class Middle : Issue3705.FriendAncestor.Ancestor { }",
                friendAncestor
            )
            let visible = CompileGSharp(`package Issue3705.Friend
import Issue3705.NeutralMiddle
class Derived : Middle {
    func Read() int32 -> this.ValueField + this.ValueProperty
}`, FriendAssemblyName, friendAncestor, neutralMiddle)
            Assert.True(visible.Success, Describe(visible))
            let noFriendAncestor = EmitCSharpLibrary(directory, "Issue3705.NoFriendAncestor", `namespace Issue3705.NoFriendAncestor;
public class Ancestor
{
    internal int ValueField = 1;
    internal int ValueProperty => 2;
}`)
            let friendlyMiddle = EmitCSharpLibrary(directory, "Issue3705.FriendlyMiddle", `using System.Runtime.CompilerServices;
[assembly: InternalsVisibleTo("Issue3705.Friend")]
namespace Issue3705.FriendlyMiddle;
public class Middle : Issue3705.NoFriendAncestor.Ancestor { }`, noFriendAncestor)
            let hidden = CompileGSharp(`package Issue3705.Friend
import Issue3705.FriendlyMiddle
class Derived : Middle {
    func Read() int32 -> this.ValueField + this.ValueProperty
}`, FriendAssemblyName, noFriendAncestor, friendlyMiddle)
            Assert.False(hidden.Success)
        } finally {
            DeleteOutputDirectory(directory)
        }
    }

    private data struct CompileResult(
        Success bool,
        Diagnostics[]Issue3705MemberKindAccessibilityDifferentialTests.DiagnosticInfo
    ) : IEquatable[Issue3705MemberKindAccessibilityDifferentialTests.CompileResult] { }

    private data struct DiagnosticInfo(Id string, Message string?) : IEquatable[
        Issue3705MemberKindAccessibilityDifferentialTests.DiagnosticInfo
    ] { }

    shared {
        private const FriendAssemblyName string = "Issue3705.Friend"
        private const StrangerAssemblyName string = "Issue3705.Stranger"
        private const LibraryAssemblyName string = "Issue3705.Library"

        /// One member of every kind at every accessibility. Indexer accessibility
        /// is discriminated by the index parameter type, since a type may declare
        /// only one indexer per signature.
        private const CSharpLibrarySource string = `using System;
using System.Runtime.CompilerServices;

[assembly: InternalsVisibleTo("Issue3705.Friend")]

namespace Issue3705.Library;

public class Surface
{
    public int PublicField;
    internal int InternalField;
    private int PrivateField;
    protected int ProtectedField;
    protected internal int ProtectedInternalField;
    private protected int PrivateProtectedField;

    public event Action PublicEvent;
    internal event Action InternalEvent;
    private event Action PrivateEvent;
    protected event Action ProtectedEvent;

    public int PublicProperty { get; set; }
    internal int InternalProperty { get; set; }
    private int PrivateProperty { get; set; }
    protected int ProtectedProperty { get; set; }
    protected internal int ProtectedInternalProperty { get; set; }
    private protected int PrivateProtectedProperty { get; set; }
    public int PublicSetterPrivateGetter { private get; set; }

    public int PublicMethod() => 1;
    internal int InternalMethod() => 1;
    private int PrivateMethod() => 1;
    protected int ProtectedMethod() => 1;
    protected internal int ProtectedInternalMethod() => 1;
    private protected int PrivateProtectedMethod() => 1;

    public int this[int index] { get => 0; set { } }
    internal int this[string index] { get => 0; set { } }
    private int this[bool index] { get => 0; set { } }
    protected int this[double index] { get => 0; set { } }

    public int Touch()
        => PrivateField + PrivateProperty + PrivateMethod() + this[true]
            + (PrivateEvent == null ? 0 : 1);
}`

        /// The differential matrix: member kind × accessibility × friend-vs-not.
        /// Every row's expectation is computed from accessibility and friendship
        /// ALONE — the member kind never appears in the expectation.
        /// @returns The theory rows.
        func Matrix() sequence[[]object] {
            let accessibilities[]string = []string{"Public", "Internal", "Private", "Protected"}
            let kinds[]string = []string{
                "MethodCall",
                "PropertyRead",
                "PropertyWrite",
                "FieldRead",
                "FieldWrite",
                "EventSubscribe",
                "IndexerRead",
                "IndexerWrite"
            }
            for kind in kinds {
                for accessibility in accessibilities {
                    for isFriend in[]bool{true, false} {
                        let visible = accessibility == "Public" || (accessibility == "Internal" && isFriend)
                        yield[]object{kind, accessibility, isFriend, visible}
                    }
                }
            }
        }

        /// Inherited-property lookup must test the accessor used by the operation,
        /// not whichever accessor reflection happens to return first.
        /// @returns The derived-member probe cases.
        func DerivedMemberCases() sequence[[]object] {
            yield[]object{"this-protected-read", "let value = this.ProtectedProperty", StrangerAssemblyName, true}
            yield[]object{"bare-protected-read", "let value = ProtectedProperty", StrangerAssemblyName, true}
            yield[]object{"base-protected-read", "let value = base.ProtectedProperty", StrangerAssemblyName, true}
            yield[]object{"this-protected-write", "this.ProtectedProperty = 7", StrangerAssemblyName, true}
            yield[]object{"bare-protected-write", "ProtectedProperty = 7", StrangerAssemblyName, true}
            yield[]object{"base-protected-write", "base.ProtectedProperty = 7", StrangerAssemblyName, true}
            yield[]object{"this-protected-method", "let value = this.ProtectedMethod()", StrangerAssemblyName, true}
            yield[]object{"bare-protected-method", "let value = ProtectedMethod()", StrangerAssemblyName, true}
            yield[]object{"base-protected-method", "let value = base.ProtectedMethod()", StrangerAssemblyName, true}
            yield[]object{
                "protected-internal-property",
                "let value = this.ProtectedInternalProperty",
                StrangerAssemblyName,
                true
            }
            yield[]object{
                "protected-internal-field",
                "let value = this.ProtectedInternalField",
                StrangerAssemblyName,
                true
            }
            yield[]object{
                "protected-internal-method",
                "let value = this.ProtectedInternalMethod()",
                StrangerAssemblyName,
                true
            }
            yield[]object{
                "this-private-getter-read",
                "let value = this.PublicSetterPrivateGetter",
                StrangerAssemblyName,
                false
            }
            yield[]object{
                "bare-private-getter-read",
                "let value = PublicSetterPrivateGetter",
                StrangerAssemblyName,
                false
            }
            yield[]object{
                "base-private-getter-read",
                "let value = base.PublicSetterPrivateGetter",
                StrangerAssemblyName,
                false
            }
            yield[]object{"this-public-setter-write", "this.PublicSetterPrivateGetter = 7", StrangerAssemblyName, true}
            yield[]object{"bare-public-setter-write", "PublicSetterPrivateGetter = 7", StrangerAssemblyName, true}
            yield[]object{"base-public-setter-write", "base.PublicSetterPrivateGetter = 7", StrangerAssemblyName, true}
            yield[]object{
                "this-friend-internal-property-read",
                "let value = this.InternalProperty",
                FriendAssemblyName,
                true
            }
            yield[]object{
                "bare-friend-internal-property-read",
                "let value = InternalProperty",
                FriendAssemblyName,
                true
            }
            yield[]object{
                "base-friend-internal-property-read",
                "let value = base.InternalProperty",
                FriendAssemblyName,
                true
            }
            yield[]object{"this-friend-internal-property-write", "this.InternalProperty = 7", FriendAssemblyName, true}
            yield[]object{"bare-friend-internal-property-write", "InternalProperty = 7", FriendAssemblyName, true}
            yield[]object{"base-friend-internal-property-write", "base.InternalProperty = 7", FriendAssemblyName, true}
            yield[]object{"this-friend-internal-field-read", "let value = this.InternalField", FriendAssemblyName, true}
            yield[]object{"bare-friend-internal-field-read", "let value = InternalField", FriendAssemblyName, true}
            yield[]object{"this-friend-internal-field-write", "this.InternalField = 7", FriendAssemblyName, true}
            yield[]object{"bare-friend-internal-field-write", "InternalField = 7", FriendAssemblyName, true}
            yield[]object{"this-friend-internal-method", "let value = this.InternalMethod()", FriendAssemblyName, true}
            yield[]object{"bare-friend-internal-method", "let value = InternalMethod()", FriendAssemblyName, true}
            yield[]object{"base-friend-internal-method", "let value = base.InternalMethod()", FriendAssemblyName, true}
            yield[]object{
                "friend-private-protected-property",
                "let value = this.PrivateProtectedProperty",
                FriendAssemblyName,
                false
            }
            yield[]object{
                "friend-private-protected-field",
                "let value = this.PrivateProtectedField",
                FriendAssemblyName,
                false
            }
            yield[]object{
                "friend-private-protected-method",
                "let value = this.PrivateProtectedMethod()",
                FriendAssemblyName,
                false
            }
            yield[]object{
                "nonfriend-internal-property-read",
                "let value = this.InternalProperty",
                StrangerAssemblyName,
                false
            }
            yield[]object{"nonfriend-internal-property-write", "this.InternalProperty = 7", StrangerAssemblyName, false}
            yield[]object{
                "nonfriend-internal-field-read",
                "let value = this.InternalField",
                StrangerAssemblyName,
                false
            }
            yield[]object{"nonfriend-internal-field-write", "this.InternalField = 7", StrangerAssemblyName, false}
            yield[]object{"nonfriend-internal-method", "let value = this.InternalMethod()", StrangerAssemblyName, false}
            yield[]object{
                "nonfriend-private-protected-property",
                "let value = this.PrivateProtectedProperty",
                StrangerAssemblyName,
                false
            }
            yield[]object{
                "nonfriend-private-protected-field",
                "let value = this.PrivateProtectedField",
                StrangerAssemblyName,
                false
            }
            yield[]object{
                "nonfriend-private-protected-method",
                "let value = this.PrivateProtectedMethod()",
                StrangerAssemblyName,
                false
            }
            yield[]object{"private-method", "let value = this.PrivateMethod()", StrangerAssemblyName, false}
        }

        private func BuildSource(kind string, accessibility string, consumer string) string {
            // The index argument selects the overload whose accessibility is under
            // test; each literal converts to exactly one of the four index types.
            let indexArgument = switch accessibility {
                case "Public": "1"
                case "Internal": "\"key\""
                case "Private": "true"
                case "Protected": "1.5"
                default: throw ArgumentOutOfRangeException("accessibility")
            }
            let body = switch kind {
                case "MethodCall": "    let value = surface.${accessibility}Method()"
                case "PropertyRead": "    let value = surface.${accessibility}Property"
                case "PropertyWrite": "    surface.${accessibility}Property = 7"
                case "FieldRead": "    let value = surface.${accessibility}Field"
                case "FieldWrite": "    surface.${accessibility}Field = 7"
                case "EventSubscribe": "    surface.${accessibility}Event += () -> { }"
                case "IndexerRead": "    let value = surface[$indexArgument]"
                case "IndexerWrite": "    surface[$indexArgument] = 7"
                default: throw ArgumentOutOfRangeException("kind")
            }
            return (`package ` + "$consumer" + `
import Issue3705.Library

func Run() {
    let surface = Surface()
` + "$body" + `
}`)
        }

        private func Describe(result Issue3705MemberKindAccessibilityDifferentialTests.CompileResult) string -> string
            .Join(
            Environment.NewLine,
            result.Diagnostics.Select(
                (d Issue3705MemberKindAccessibilityDifferentialTests.DiagnosticInfo) -> d.Id + ": " + d.Message
            )
        )

        private func CompileGSharp(
            source string,
            assemblyName string,
            references ...string
        ) Issue3705MemberKindAccessibilityDifferentialTests
            .CompileResult {
            using let resolver = ReferenceResolver.WithReferences(references)
            resolver.CurrentAssemblyName = assemblyName
            let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(source))){
                AssemblyName = assemblyName
            }
            using let output = MemoryStream()
            let emit = compilation.Emit(output, pdbStream: nil, refStream: nil, assemblyName: assemblyName)
            return Issue3705MemberKindAccessibilityDifferentialTests.CompileResult(
                emit.Success,
                emit
                    .Diagnostics
                    .Select(
                    (
                        d GSharp.Core.CodeAnalysis.Diagnostic
                    ) -> Issue3705MemberKindAccessibilityDifferentialTests.DiagnosticInfo(d.Id, d.Message)
                )
                    .ToArray()
            )
        }

        private func EmitCSharpLibrary(
            directory string,
            assemblyName string,
            source string,
            additionalReferences ...string
        ) string {
            let references = (
                (AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES") as string)?.Split(Path.PathSeparator) ??
                    Array.Empty[string]()
            )
                .Where(File.Exists)
                .Concat(additionalReferences)
                .Distinct(StringComparer.OrdinalIgnoreCase)
                .Select((path string) -> cast[MetadataReference](MetadataReference.CreateFromFile(path)))
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
                "Issue3705MemberKindAccessibilityDifferentialTests",
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
