// <copyright file="AssemblyInfo.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

// Tests in this assembly mutate process-wide state (Console.Out/Error, the
// current working directory), so they must not run in parallel with each other.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
