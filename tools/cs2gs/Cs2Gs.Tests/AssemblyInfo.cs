// <copyright file="AssemblyInfo.cs" company="GSharp">
// Copyright (C) GSharp Authors. All rights reserved.
// </copyright>

using Xunit;

// SDK-backed tests launch nested builds that share process and package state.
[assembly: CollectionBehavior(DisableTestParallelization = true)]
