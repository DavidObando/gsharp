// <copyright file="Issue4808ImportedSealedHierarchyTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Compiler.Tests.Emit

import System
import System.IO
import GSharp.Core.Tests
import GSharp.Tests
import Xunit
import GSharp.Compiler.Tests

/// ADR-0078: sealed hierarchies cannot acquire subclasses in another assembly.
/// @remarks ADR-0154: the final oracle rejects genuine 9c products because the foreign
/// subclass is admitted, even though its IL verifies. Restoring the fixed
/// producer/importer passes, with native records and legal hierarchies as controls.
class Issue4808ImportedSealedHierarchyTests {
    @Theory
    @InlineData("data ", "Root", "Leaf", false, "Consumer")
    @InlineData("data ", "Root", "Leaf", true, "Consumer")
    @InlineData("data ", "GenericRoot[string]", "Leaf", false, "Consumer")
    @InlineData("data ", "GenericRoot[string]", "Leaf", true, "Consumer")
    @InlineData("data ", "GenericRoot[T]", "Leaf[T any]", false, "Consumer")
    @InlineData("data ", "GenericRoot[T]", "Leaf[T any]", true, "Consumer")
    @InlineData("", "Root", "Leaf", false, "Consumer")
    @InlineData("", "Root", "Leaf", true, "Consumer")
    @InlineData("", "GenericRoot[string]", "Leaf", false, "Consumer")
    @InlineData("", "GenericRoot[string]", "Leaf", true, "Consumer")
    @InlineData("", "GenericRoot[T]", "Leaf[T any]", false, "Consumer")
    @InlineData("", "GenericRoot[T]", "Leaf[T any]", true, "Consumer")
    @InlineData("data ", "Root", "Leaf", false, "Owner")
    func ForeignSealedHierarchy_RejectsWithNoImage(
        kind string,
        baseType string,
        declaration string,
        referenceAssembly bool,
        consumerName string
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let reference = Path.Combine(fixture.Directory, "Owner.ref.dll")
        let owner = fixture.Compile((`package SealedImported
@assembly:InternalsVisibleTo("Consumer")
public sealed ` + "$kind" + `class Root(Tag int32)
public sealed ` + "$kind" + `class GenericRoot[T any](Tag int32)`), "Owner", executable: false, "/assemblyname:Owner", "/refout:" +
                reference)
        IlVerifier.Verify(owner)
        let root Type? = EmittedFixture.Load(File.ReadAllBytes(owner), fixture.Directory).GetType("SealedImported.Root")
        Assert.NotNull(root)
        Assert.False(root!!.IsSealed)
        let consumerReference = Path.Combine(fixture.Directory, "Rejected.ref.dll")
        let source = (`package SealedImported
public class ` + "$declaration" + `(Extra int32) : ` + "$baseType" + `(0)`)
        let (code, output) = fixture.TryCompile(
            source,
            "Rejected",
            executable: false,
            "/assemblyname:" + consumerName,
            "/refout:" + consumerReference,
            "/r:" +
                (
                if referenceAssembly {
                    reference
                } else {
                    owner
                }
            )
        )
        Assert.True(code != 0, "Foreign sealed hierarchy was admitted:\n" + output)
        let identifier = baseType.Split('[')[0]
        let column = source.Split('\n')[1].IndexOf(identifier, StringComparison.Ordinal) + 1
        Assert.Contains(
            "Rejected.gs(2,$column,2,${column + identifier.Length}): error GS0181",
            output,
            StringComparison.Ordinal
        )
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "Rejected.dll")))
        Assert.False(File.Exists(consumerReference))
    }

    @Theory
    @InlineData("data ", "Root", "Leaf", false)
    @InlineData("data ", "GenericRoot[string]", "Leaf", false)
    @InlineData("data ", "GenericRoot[T]", "Leaf[T any]", false)
    @InlineData("", "Root", "Leaf", false)
    @InlineData("", "GenericRoot[string]", "Leaf", false)
    @InlineData("", "GenericRoot[T]", "Leaf[T any]", false)
    @InlineData("data ", "Root", "Leaf", true)
    @InlineData("data ", "GenericRoot[string]", "Leaf", true)
    @InlineData("data ", "GenericRoot[T]", "Leaf[T any]", true)
    @InlineData("", "Root", "Leaf", true)
    @InlineData("", "GenericRoot[string]", "Leaf", true)
    @InlineData("", "GenericRoot[T]", "Leaf[T any]", true)
    func SameAssemblySealedAndForeignOpenHierarchies_VerifyAndRun(
        kind string,
        baseType string,
        declaration string,
        foreign bool
    ) {
        using let fixture = NativeSliceLanguageTests.Fixture()
        let modifier = if foreign {
            "open"
        } else {
            "sealed"
        }
        let ownerSource = (`package SealedImported
public ` + "$modifier" + ` ` + "$kind" + `class Root(Tag int32)
public ` + "$modifier" + ` ` + "$kind" + `class GenericRoot[T any](Tag int32)`)
        let ownerReference = Path.Combine(fixture.Directory, "Owner.ref.dll")
        let owner string? = if foreign {
            fixture.Compile(ownerSource, "Owner", executable: false, "/assemblyname:Owner", "/refout:" + ownerReference)
        } else {
            default(string?)
        }
        let constructor = if declaration.Contains("[", StringComparison.Ordinal) {
            "Leaf[string]"
        } else {
            "Leaf"
        }
        let source = (`package SealedImported
public class ` + "$declaration" + `(Extra int32) : ` + "$baseType" + `(41)
func Main() {
    let leaf = ` + "$constructor" + `(7)
    System.Console.WriteLine(leaf.Tag.ToString() + ":" + leaf.Extra.ToString())
}`)
        let program = fixture.Compile(
            if foreign {
                source
            } else {
                ownerSource + "\n" + source.Substring("package SealedImported\n".Length)
            },
            "Legal",
            executable: true,
            "/assemblyname:Legal",
            if foreign {
                "/r:" + ownerReference
            } else {
                "/targetframework:net10.0"
            }
        )
        if owner != nil {
            IlVerifier.Verify(owner)
        }
        IlVerifier.Verify(
            program,
            if owner == nil {
                default([]?string)
            } else {
                []string{owner}
            }
        )
        Assert.Equal("41:7\n", fixture.Run(program))
    }

    @Fact
    func LegacyMarkedClass_StillConstructsButCannotClaimUnknownInheritancePermission() {
        using let contract = CSharpFixture(`[assembly: System.Reflection.AssemblyMetadata("GSharp.TypeSemantics", "33554434|class|1|Tag:67108865")]
namespace SealedImported;
public class Root {
    public int Tag;
    public Root(int tag) => Tag = tag;
}`)
        using let fixture = NativeSliceLanguageTests.Fixture()
        let program = fixture.Compile(`package SealedImported
func Main() {
    let root = Root(41)
    System.Console.WriteLine(root.Tag)
}`, "Legacy", executable: true, "/r:" + contract.AssemblyPath)
        IlVerifier.Verify(contract.AssemblyPath)
        IlVerifier.Verify(program, []string{contract.AssemblyPath})
        File.Copy(contract.AssemblyPath, Path.Combine(fixture.Directory, Path.GetFileName(contract.AssemblyPath)))
        Assert.Equal("41\n", fixture.Run(program))
        let (code, output) = fixture.TryCompile(
            "package SealedImported\npublic class Leaf(Extra int32) : Root(0)",
            "LegacyRejected",
            executable: false,
            "/r:" + contract.AssemblyPath
        )
        Assert.True(code != 0, "Missing G# inheritance mode was treated as open:\n" + output)
        Assert.Contains("LegacyRejected.gs(2,34,2,38): error GS0181", output, StringComparison.Ordinal)
        Assert.False(File.Exists(Path.Combine(fixture.Directory, "LegacyRejected.dll")))
    }
}
