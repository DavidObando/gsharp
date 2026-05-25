// <copyright file="GeneratedNamesTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.CodeAnalysis.Lowering.Async;
using Xunit;

namespace GSharp.Core.Tests.CodeAnalysis.Lowering.Async;

/// <summary>
/// Naming determinism of <see cref="GeneratedNames"/>. The exact strings
/// are part of the contract with the debugger and any decompiler/PDB
/// tooling, so changes here are intentional and visible.
/// </summary>
public class GeneratedNamesTests
{
    [Fact]
    public void Constants_MatchRoslynShape()
    {
        Assert.Equal("<>1__state", GeneratedNames.StateField);
        Assert.Equal("<>t__builder", GeneratedNames.BuilderField);
        Assert.Equal("<>4__this", GeneratedNames.ThisField);
    }

    [Fact]
    public void ParameterField_ManglesUserName()
    {
        Assert.Equal("<>3__url", GeneratedNames.ParameterField("url"));
    }

    [Fact]
    public void HoistedLocalField_IncludesOrdinal()
    {
        Assert.Equal("<x>5__1", GeneratedNames.HoistedLocalField("x", 1));
    }

    [Fact]
    public void AwaiterField_IncludesOrdinal()
    {
        Assert.Equal("<>u__2", GeneratedNames.AwaiterField(2));
    }

    [Fact]
    public void StateMachineTypeName_IncludesMethodNameAndOrdinal()
    {
        Assert.Equal("<Sum>d__0", GeneratedNames.StateMachineTypeName("Sum", 0));
    }
}
