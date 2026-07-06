// <copyright file="ResxTypeNameMapperTests.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using GSharp.Core.Resx;
using Xunit;

namespace GSharp.Core.Tests.Resx;

public class ResxTypeNameMapperTests
{
    [Theory]
    [InlineData("System.Byte[], mscorlib, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089", "[]uint8")]
    [InlineData("System.String, mscorlib", "string")]
    [InlineData("System.Int32, mscorlib", "int32")]
    [InlineData("System.Drawing.Bitmap, System.Drawing", "System.Drawing.Bitmap")]
    [InlineData("System.Int32[][], mscorlib", "[][]int32")]
    public void Map_ReturnsExpectedGSharpType(string assemblyQualifiedTypeName, string expected)
    {
        Assert.Equal(expected, ResxTypeNameMapper.Map(assemblyQualifiedTypeName));
    }
}
