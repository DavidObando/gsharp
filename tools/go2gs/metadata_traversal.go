// Copyright (C) GSharp Authors. All rights reserved.

package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"sort"
)

const (
	metadataReadDirBatchSize    = 128
	maxMetadataDirectoryEntries = 10_000
	maxSourceTraversalEntries   = 100_000
)

var metadataReadDirBatchTestHook func(string)
var metadataDirectorySortTestHook func(string)
var metadataDirectoryEntryLimitTestHook func() int
var sourceTraversalEntryLimitTestHook func() int

type metadataTraversalBudget struct {
	entries int
	limit   int
}

func newMetadataTraversalBudget() metadataTraversalBudget {
	limit := maxSourceTraversalEntries
	if sourceTraversalEntryLimitTestHook != nil {
		limit = sourceTraversalEntryLimitTestHook()
	}
	return metadataTraversalBudget{limit: limit}
}

func (budget *metadataTraversalBudget) consume(count int) error {
	if budget == nil || budget.limit <= 0 {
		return errors.New("metadata traversal entry limit is invalid")
	}
	if count > budget.limit-budget.entries {
		return fmt.Errorf("metadata traversal exceeds entry limit %d", budget.limit)
	}
	budget.entries += count
	return nil
}

func metadataDirectoryEntryLimit() int {
	if metadataDirectoryEntryLimitTestHook != nil {
		return metadataDirectoryEntryLimitTestHook()
	}
	return maxMetadataDirectoryEntries
}

func readMetadataDirectoryEntriesContext(
	ctx context.Context,
	directory *os.File,
	budget *metadataTraversalBudget,
) ([]os.DirEntry, error) {
	var entries []os.DirEntry
	directoryEntries := 0
	directoryLimit := metadataDirectoryEntryLimit()
	if directoryLimit <= 0 {
		return nil, errors.New("metadata directory entry limit is invalid")
	}
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		batch, err := directory.ReadDir(metadataReadDirBatchSize)
		if metadataReadDirBatchTestHook != nil {
			metadataReadDirBatchTestHook(directory.Name())
		}
		if contextErr := ctx.Err(); contextErr != nil {
			return nil, contextErr
		}
		if len(batch) > 0 {
			if len(batch) > directoryLimit-directoryEntries {
				return nil, fmt.Errorf(
					"metadata directory exceeds entry limit %d", directoryLimit)
			}
			if err := budget.consume(len(batch)); err != nil {
				return nil, err
			}
			directoryEntries += len(batch)
			entries = append(entries, batch...)
		}
		if errors.Is(err, io.EOF) {
			break
		}
		if err != nil {
			return nil, err
		}
	}
	if metadataDirectorySortTestHook != nil {
		metadataDirectorySortTestHook(directory.Name())
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name() < entries[j].Name() })
	return entries, nil
}
