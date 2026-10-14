// <copyright file="Issue3461IdentifierAttributeEmitTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

package GSharp.Core.Tests.CodeAnalysis.Emit

import GSharp.Core.CodeAnalysis
import GSharp.Core.CodeAnalysis.Compilation
import GSharp.Core.CodeAnalysis.Symbols
import GSharp.Core.CodeAnalysis.Syntax
import GSharp.Core.CodeAnalysis.Text
import GSharp.Core.Tests.Fixtures
import System
import System.IO
import System.Linq
import System.Reflection
import System.Runtime.Loader
import Xunit

/// Issue #3461: emitted attribute names map back to CLR metadata names.
class Issue3461IdentifierAttributeEmitTests {
    @Fact
    func ImportedReservedNamedArguments_RoundTripThroughMetadata() {
        let fixtureAssembly = typeof(ImportedReservedNamedAttribute).Assembly.Location
        using let resolver = ReferenceResolver.WithReferences([]string{fixtureAssembly})
        let compilation = Compilation(resolver, SyntaxTree.Parse(SourceText.From(`import GSharp.Core.Tests.Fixtures

@ImportedReservedNamed("a", "b", $type = "c", type_ = "d")
class Tagged {
}`)))
        using let stream = MemoryStream()
        let emit = compilation.Emit(stream)
        Assert.True(
            emit.Success,
            string.Join("; ", emit.Diagnostics.Select((diagnostic Diagnostic) -> diagnostic.Message))
        )
        stream.Position = 0
        let loadContext = AssemblyLoadContext(
            "ImportedReservedNamedArguments_RoundTripThroughMetadata",
            isCollectible: true
        )
        try {
            loadContext.Resolving += (_ AssemblyLoadContext, name AssemblyName) -> if name.Name == typeof(
                ImportedReservedNamedAttribute
            )
                .Assembly
                .GetName()
                .Name {
                typeof(ImportedReservedNamedAttribute).Assembly
            } else {
                default(Assembly?)
            }
            let assembly = loadContext.LoadFromStream(stream)
            let tagged = assembly.GetTypes().Single((candidateType Type) -> candidateType.Name == "Tagged")
            let attribute = tagged.GetCustomAttributesData().Single(
                (candidate CustomAttributeData) -> candidate.AttributeType == typeof(ImportedReservedNamedAttribute)
            )
            Assert.Equal(
                cast[[]object]([]string{"a", "b"}),
                attribute
                    .ConstructorArguments
                    .Select((argument CustomAttributeTypedArgument) -> argument.Value!!)
                    .ToArray()
            )
            Assert.Equal(
                []string{"type", "type_"},
                attribute
                    .NamedArguments
                    .Select((argument CustomAttributeNamedArgument) -> argument.MemberName)
                    .ToArray()
            )
        } finally {
            loadContext.Unload()
        }
    }
}
