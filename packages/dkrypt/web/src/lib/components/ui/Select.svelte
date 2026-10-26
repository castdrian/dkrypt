<script lang="ts">
	import { Select as SelectPrimitive } from "bits-ui";
	import { Check, ChevronDown } from "lucide-svelte";
	import { cn } from "#lib/utils";

	interface Item {
		value: string;
		label: string;
		color?: string;
	}

	interface Props {
		items: Item[];
		value: string;
		onValueChange?: (value: string) => void;
		class?: string;
		placeholder?: string;
		id?: string;
		disabled?: boolean;
		ariaLabel?: string;
	}

	let {
		items,
		value = $bindable(),
		onValueChange,
		class: className,
		placeholder = "Select…",
		id,
		disabled = false,
		ariaLabel,
	}: Props = $props();

	const selectedItem = $derived(items.find((i) => i.value === value));
</script>

<SelectPrimitive.Root type="single" bind:value {onValueChange} {disabled}>
	<SelectPrimitive.Trigger
		{id}
		aria-label={ariaLabel ? `${selectedItem?.label ?? placeholder} (${ariaLabel})` : id ? undefined : selectedItem?.label ?? placeholder}
		data-slot="select-trigger"
		class={cn(
			"border-input bg-background ring-offset-background flex h-9 items-center justify-between gap-2 rounded-md border px-3 text-sm text-foreground shadow-sm focus:ring-ring focus:ring-2 focus:ring-offset-2 focus:outline-none disabled:cursor-not-allowed disabled:opacity-50",
			className,
		)}
	>
		<span class="flex min-w-0 items-center gap-2 truncate">
			{#if selectedItem?.color}<span
					class="h-2.5 w-2.5 shrink-0 rounded-full"
					style="background-color: {selectedItem.color}"
				></span>{/if}
			<span class="truncate">{selectedItem?.label ?? placeholder}</span>
		</span>
		<ChevronDown class="text-muted h-4 w-4 shrink-0" />
	</SelectPrimitive.Trigger>
	<SelectPrimitive.Portal>
		<SelectPrimitive.Content
			data-slot="select-content"
			class="border-border bg-popover text-popover-foreground z-50 overflow-hidden rounded-md border p-1 shadow-md"
			style="width: var(--bits-floating-anchor-width); min-width: max(var(--bits-floating-anchor-width), 10rem);"
			sideOffset={4}
		>
			<SelectPrimitive.Viewport class="p-1">
				{#each items as item (item.value)}
					<SelectPrimitive.Item
						value={item.value}
						label={item.label}
						class="data-highlighted:bg-secondary data-highlighted:ring-ring flex cursor-pointer items-center justify-between rounded-md px-2.5 py-2 text-sm text-foreground data-highlighted:ring-1"
					>
						{#snippet children({ selected })}
							<span class="flex min-w-0 items-center gap-2">
								{#if item.color}<span
										class="h-2.5 w-2.5 shrink-0 rounded-full"
										style="background-color: {item.color}"
									></span>{/if}
								<span class="truncate">{item.label}</span>
							</span>
							{#if selected}<Check
									class="text-primary h-4 w-4"
								/>{/if}
						{/snippet}
					</SelectPrimitive.Item>
				{/each}
			</SelectPrimitive.Viewport>
		</SelectPrimitive.Content>
	</SelectPrimitive.Portal>
</SelectPrimitive.Root>
