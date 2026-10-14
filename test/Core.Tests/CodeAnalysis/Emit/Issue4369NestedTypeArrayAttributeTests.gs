// <copyright file="Issue4369NestedTypeArrayAttributeTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis.Binding
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import GsCompilation = GSharp.Core.CodeAnalysis.Compilation.Compilation
import GsSyntaxTree = GSharp.Core.CodeAnalysis.Syntax.SyntaxTree
import Microsoft.CodeAnalysis
import Microsoft.CodeAnalysis.CSharp
import System
import System.Collections.Generic
import System.Collections.Immutable
import System.IO
import System.Linq
import System.Reflection
import Xunit

/// Issue #4369: nested attribute arrays retain their source static type.
class Issue4369NestedTypeArrayAttributeTests {
    @Fact
    func BinderRetainsNestedTypeArrayStaticTypeButLeavesObjectArrayUnwrapped() {
        let scope_ = GSharp
            .Core
            .CodeAnalysis
            .Binding
            .Binder
            .BindGlobalScope(previous: nil, ImmutableArray.Create(GsSyntaxTree.Parse(`package App
import System

class ValuesAttribute(Values []object) : Attribute {}

@Values([]object{[]Type{typeof(Local)}, []object{"control"}})
class Local {}`)))
        Assert.Empty(scope_.Diagnostics)
        let attribute = Assert.Single(scope_.Structs.Single((type StructSymbol) -> type.Name == "Local").Attributes)
        let outer = Assert.IsType[[]object](Assert.Single(attribute.PositionalArguments).Value)
        let nestedTypeArray = Assert.IsType[BoundAttributeArgument](outer[0])
        let staticElementType TypeSymbol? = switch nestedTypeArray.Type {
            case array is ArrayTypeSymbol: array.ElementType
            case slice is SliceTypeSymbol: slice.ElementType
            default: default(TypeSymbol?)
        }
        Assert.NotNull(staticElementType)
        Assert.Equal(typeof(Type), staticElementType!!.ClrType)
        Assert.IsType[[]object](nestedTypeArray.Value)
        Assert.IsType[[]object](outer[1])
    }

    @Fact
    func EmittedMetadataRoundTripsLikeEquivalentRoslynAttribute() {
        using let contracts = Issue4369NestedTypeArrayAttributeContracts()
        const assemblyName = "Issue4369.Subject"
        const gsSource = `package App
import System
import Issue4369.Contracts

@Values([]object{[]Type{typeof(Local)}, []object{"control"}})
class Local {}`
        const csSource = `using System;
using Issue4369.Contracts;

namespace App;

[Values(new object[] { new Type[] { typeof(Local) }, new object[] { "control" } })]
public class Local {}`
        var gsImage[]uint8
        {
            using let resolver = ReferenceResolver.WithReferences([]string{contracts.Path})
            {
                using let stream = MemoryStream()
                let compilation = GsCompilation(resolver, GsSyntaxTree.Parse(SourceText.From(gsSource))){
                    IsLibrary = true
                }
                let result = compilation.Emit(stream, pdbStream: nil, refStream: nil, assemblyName)
                Assert.True(result.Success, string.Join(Environment.NewLine, result.Diagnostics))
                gsImage = stream.ToArray()
            }
        }
        let csCompilation = CSharpCompilation.Create(
            assemblyName,
            []Microsoft.CodeAnalysis.SyntaxTree{CSharpSyntaxTree.ParseText(csSource)},
            ReferenceResolver
                .HostTrustedPlatformAssemblyPaths()
                .Append(contracts.Path)
                .Select((path string) -> MetadataReference.CreateFromFile(path)),
            CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary)
        )
        using let csStream = MemoryStream()
        let csResult = csCompilation.Emit(csStream)
        Assert.True(csResult.Success, string.Join(Environment.NewLine, csResult.Diagnostics))
        Assert.Equal(
            DescribeAttribute(contracts.LoadWith(csStream.ToArray())),
            DescribeAttribute(contracts.LoadWith(gsImage))
        )
    }

    shared {
        private func DescribeAttribute(assemblies(Contract Assembly, Subject Assembly)) string {
            let attributeType Type? = assemblies.Contract.GetType("Issue4369.Contracts.ValuesAttribute")
            let target Type? = assemblies.Subject.GetType("App.Local")
            let argument = Assert.Single(
                Assert.Single(
                    target!!.GetCustomAttributesData(),
                    (item CustomAttributeData) -> item.AttributeType == attributeType
                )
                    .ConstructorArguments
            )
            return Describe(argument)
        }

        private func Describe(argument CustomAttributeTypedArgument) string {
            if argument.Value is IReadOnlyCollection[CustomAttributeTypedArgument]elements {
                return argument.ArgumentType.FullName + "[" + string.Join(",", elements.Select(Describe)) + "]"
            }
            return argument
                .ArgumentType
                .FullName +
                ":" +
                (
                if argument.Value is Type type {
                    (type.FullName as object)
                } else {
                    argument.Value
                }
            )?.ToString()
        }
    }
}
