// <copyright file="Issue2832RefAssemblyIndexerEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Syntax
import System.IO
import System.Linq
import System.Reflection.Metadata
import System.Reflection.PortableExecutable
import Xunit

/// Issue #2832: `MemberDefEmitter.EmitPropertyAccessorBody` returns "no
/// body" under (cref:GSharp.Core.CodeAnalysis.Emit.EmitContext.MetadataOnly),
/// which pushed `EmitPropertyGetter`/`EmitPropertySetter` onto their
/// fallback signature paths. Those paths hard-coded zero/one parameter, so an
/// indexer's accessors landed in the reference assembly without their index
/// parameters — the property stopped being an indexer and every consumer
/// compiled against `obj/…/ref/` failed with GS0116. These tests pin that
/// the reference assembly's accessor signatures match the runtime assembly's.
open class Issue2832RefAssemblyIndexerEmitTests {
    @Theory
    @InlineData("get_Item")
    @InlineData("set_Item")
    @InlineData("get_Count")
    func ReferenceAssembly_AccessorSignature_MatchesRuntimeAssembly(accessorName string) {
        let (runtime, reference) = EmitBoth(IndexerSource)
        Assert.Equal(SignatureOf(runtime, accessorName), SignatureOf(reference, accessorName))
    }

    @Theory
    @InlineData("get_Item")
    @InlineData("set_Item")
    func ReferenceAssembly_MultiParameterIndexerSignature_MatchesRuntimeAssembly(accessorName string) {
        let (runtime, reference) = EmitBoth(MultiParamIndexerSource)
        Assert.Equal(SignatureOf(runtime, accessorName), SignatureOf(reference, accessorName))
    }

    @Fact
    func ReferenceAssembly_IndexerSetter_ValueParameterFollowsIndexParameters() {
        let (_, reference) = EmitBoth(MultiParamIndexerSource)
        reference.Position = 0
        using let pe = PEReader(reference, PEStreamOptions.LeaveOpen)
        let md = pe.GetMetadataReader()
        let setter = md
            .MethodDefinitions
            .Select(md.GetMethodDefinition)
            .Single((m MethodDefinition) -> md.GetString(m.Name) == "set_Item")
        // Two index parameters precede `value`, so its sequence number is 3.
        let sequenceNumbers = setter
            .GetParameters()
            .Select((h ParameterHandle) -> md.GetParameter(h).SequenceNumber)
            .ToArray()
        Assert.Equal([]int32{3}, sequenceNumbers)
    }

    shared {
        private const IndexerSource string = `package IdxPkg

public class Box {
    var items []string

    public func New() {
        items = []string{"", "", "", ""}
    }

    public prop this[i int32] string {
        get { return items!![i] }
        set { items!![i] = value }
    }

    public prop Count int32 {
        get { return 4 }
    }
}`

        private const MultiParamIndexerSource string = `package GridPkg

public class Grid {
    var cells []int32

    public func New() {
        cells = []int32{0, 0, 0, 0}
    }

    public prop this[row int32, column int32] int32 {
        get { return cells!![(row * 2) + column] }
        set { cells!![(row * 2) + column] = value }
    }
}`

        private func EmitBoth(source string)(Runtime MemoryStream, Reference MemoryStream) {
            let peStream = MemoryStream()
            let refStream = MemoryStream()
            let compilation = Compilation(SyntaxTree.Parse(source))
            let result = compilation.Emit(peStream, refStream)
            Assert.True(
                result.Success,
                "compilation should succeed: " + string.Join(
                    "; ",
                    result.Diagnostics.Select((d Diagnostic) -> d.Message)
                )
            )
            return (peStream, refStream)
        }

        private func SignatureOf(assembly MemoryStream, methodName string)[]uint8 {
            assembly.Position = 0
            using let pe = PEReader(assembly, PEStreamOptions.LeaveOpen)
            let md = pe.GetMetadataReader()
            let method = md
                .MethodDefinitions
                .Select(md.GetMethodDefinition)
                .Single((m MethodDefinition) -> md.GetString(m.Name) == methodName)
            return md.GetBlobBytes(method.Signature)
        }
    }
}
