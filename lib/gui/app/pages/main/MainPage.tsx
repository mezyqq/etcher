/*
 * Copyright 2019 balena.io
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import CogSvg from '@fortawesome/fontawesome-free/svgs/solid/gear.svg';
import CloseSvg from '@fortawesome/fontawesome-free/svgs/solid/x.svg';
import ChevronDownSvg from '@fortawesome/fontawesome-free/svgs/solid/chevron-down.svg';
import ChevronRightSvg from '@fortawesome/fontawesome-free/svgs/solid/chevron-right.svg';
import QuestionCircleSvg from '@fortawesome/fontawesome-free/svgs/solid/circle-question.svg';

import * as path from 'path';
import prettyBytes from 'pretty-bytes';
import * as React from 'react';
import { Alert, Button, Flex, Link, Txt } from 'rendition';
import styled from 'styled-components';

import FinishPage from '../../components/finish/finish';
import { ReducedFlashingInfos } from '../../components/reduced-flashing-infos/reduced-flashing-infos';
import { SettingsModal } from '../../components/settings/settings';
import { SourceSelector } from '../../components/source-selector/source-selector';
import type { SourceMetadata } from '../../../../shared/typings/source-selector';
import * as flashState from '../../models/flash-state';
import * as selectionState from '../../models/selection-state';
import * as settings from '../../models/settings';
import { observe } from '../../models/store';
import { selectFolder } from '../../os/dialog';
import * as i18next from 'i18next';
import { open as openExternal } from '../../os/open-external/services/open-external';
import {
	IconButton as BaseIcon,
	IconButton,
	ThemedProvider,
} from '../../styled-components';

import {
	TargetSelector,
	getDriveListLabel,
} from '../../components/target-selector/target-selector';
import { FlashStep } from './Flash';

import EtcherSvg from '../../../assets/etcher.svg';
import { SafeWebview } from '../../components/safe-webview/safe-webview';
import { theme } from '../../theme';

const Icon = styled(BaseIcon)`
	margin-right: 20px;
`;

function getDrivesTitle() {
	const drives = selectionState.getSelectedDrives();

	if (drives.length === 1) {
		return drives[0].description || 'Untitled Device';
	}

	if (drives.length === 0) {
		return 'No targets found';
	}

	return `${drives.length} Targets`;
}

function getImageBasename(image?: SourceMetadata) {
	if (image === undefined) {
		return '';
	}

	if (image.drive) {
		return image.drive.description;
	}
	const imageBasename = path.basename(image.path);
	return image.name || imageBasename;
}

const StepBorder = styled.div<{
	disabled: boolean;
	left?: boolean;
	right?: boolean;
}>`
	position: relative;
	height: 2px;
	background-color: ${(props) =>
		props.disabled
			? props.theme.colors.dark.disabled.foreground
			: props.theme.colors.dark.foreground};
	width: 120px;
	top: 19px;

	left: ${(props) => (props.left ? '-67px' : undefined)};
	margin-right: ${(props) => (props.left ? '-120px' : undefined)};
	right: ${(props) => (props.right ? '-67px' : undefined)};
	margin-left: ${(props) => (props.right ? '-120px' : undefined)};
`;

const ANALYTICS_ALERT_VISIBILITY_KEY = 'analytics_alert_visible';

type FlashMode = 'linux' | 'windows';

const Tabs = styled(Flex)`
	border: 1px solid ${(props) => props.theme.colors.dark.foreground};
	border-radius: 18px;
	padding: 3px;
	// Make touch events click instead of dragging
	-webkit-app-region: no-drag;
`;

const Tab = styled.button<
	{ active: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>
>`
	border: none;
	border-radius: 15px;
	padding: 6px 22px;
	font-size: 14px;
	font-weight: 600;
	cursor: pointer;
	color: ${(props) =>
		props.active
			? props.theme.colors.primary.foreground
			: props.theme.colors.dark.foreground};
	background-color: ${(props) =>
		props.active ? props.theme.colors.primary.background : 'transparent'};

	&:disabled {
		cursor: default;
		opacity: ${(props) => (props.active ? 1 : 0.4)};
	}
`;

function isWindowsCompatibleSource(image?: SourceMetadata) {
	return (
		image === undefined ||
		(image.SourceType === 'File' && /\.iso$/i.test(image.path))
	);
}

interface MainPageStateFromStore {
	isFlashing: boolean;
	hasImage: boolean;
	hasDrive: boolean;
	imageLogo?: string;
	imageSize?: number;
	imageName?: string;
	driveTitle: string;
	driveLabel: string;
}

interface MainPageState {
	current: 'main' | 'success';
	isWebviewShowing: boolean;
	hideSettings: boolean;
	featuredProjectURL?: string;
	analyticsAlertIsVisible: boolean;
	flashMode: FlashMode;
	windowsDriversPath: string;
	showWindowsAdvanced: boolean;
}

export class MainPage extends React.Component<
	object,
	MainPageState & MainPageStateFromStore
> {
	constructor(props: object) {
		super(props);
		this.state = {
			current: 'main',
			isWebviewShowing: false,
			hideSettings: true,
			analyticsAlertIsVisible:
				localStorage.getItem(ANALYTICS_ALERT_VISIBILITY_KEY) !== 'false',
			flashMode: settings.getSync('flashMode') ?? 'linux',
			windowsDriversPath: settings.getSync('windowsDriversPath') ?? '',
			showWindowsAdvanced: false,
			...this.stateHelper(),
		};
	}

	private stateHelper(): MainPageStateFromStore {
		const image = selectionState.getImage();
		return {
			isFlashing: flashState.isFlashing(),
			hasImage: selectionState.hasImage(),
			hasDrive: selectionState.hasDrive(),
			imageLogo: image?.logo,
			imageSize: image?.size,
			imageName: getImageBasename(selectionState.getImage()),
			driveTitle: getDrivesTitle(),
			driveLabel: getDriveListLabel(),
		};
	}

	private async getFeaturedProjectURL() {
		const url = new URL(
			(await settings.get('featuredProjectEndpoint')) ||
				'https://efp.balena.io/index.html',
		);
		url.searchParams.append('borderRight', 'false');
		url.searchParams.append('darkBackground', 'true');
		return url.toString();
	}

	private hideAnalyticsAlert = () => {
		if (this.state.analyticsAlertIsVisible) {
			localStorage.setItem(ANALYTICS_ALERT_VISIBILITY_KEY, 'false');
			this.setState({ analyticsAlertIsVisible: false });
		}
	};

	public async componentDidMount() {
		observe(() => {
			this.setState(this.stateHelper());
		});
		const windowsDriversPath = (await settings.get('windowsDriversPath')) ?? '';
		this.setState({
			featuredProjectURL: await this.getFeaturedProjectURL(),
			flashMode: (await settings.get('flashMode')) ?? 'linux',
			windowsDriversPath,
			// Keep active advanced options in sight
			showWindowsAdvanced: windowsDriversPath !== '',
		});
	}

	private async setFlashMode(flashMode: FlashMode) {
		if (this.state.isFlashing || flashMode === this.state.flashMode) {
			return;
		}
		if (
			flashMode === 'windows' &&
			!isWindowsCompatibleSource(selectionState.getImage())
		) {
			selectionState.deselectImage();
		}
		this.setState({ flashMode });
		await settings.set('flashMode', flashMode);
	}

	private async setWindowsDriversPath(windowsDriversPath: string) {
		this.setState({ windowsDriversPath });
		await settings.set('windowsDriversPath', windowsDriversPath);
	}

	private async selectWindowsDrivers() {
		const folder = await selectFolder(i18next.t('windows.selectDrivers'));
		if (folder) {
			await this.setWindowsDriversPath(folder);
		}
	}

	private renderTabs() {
		const modes: Array<[FlashMode, string]> = [
			['linux', i18next.t('windows.tabLinux')],
			['windows', i18next.t('windows.tabWindows')],
		];
		return (
			<Flex justifyContent="center" mt="56px" mb="20px">
				<Tabs>
					{modes.map(([mode, label]) => (
						<Tab
							key={mode}
							active={this.state.flashMode === mode}
							disabled={this.state.isFlashing}
							onClick={() => this.setFlashMode(mode)}
						>
							{label}
						</Tab>
					))}
				</Tabs>
			</Flex>
		);
	}

	private renderWindowsOptions() {
		const { windowsDriversPath, showWindowsAdvanced } = this.state;
		const Chevron = showWindowsAdvanced ? ChevronDownSvg : ChevronRightSvg;
		return (
			<Flex
				mt="24px"
				flexDirection="column"
				style={{ fontSize: '12px', color: theme.colors.dark.foreground }}
			>
				<Link
					onClick={() =>
						this.setState({ showWindowsAdvanced: !showWindowsAdvanced })
					}
					style={{ alignSelf: 'flex-start' }}
				>
					<Chevron height="0.8em" fill="currentColor" />{' '}
					{i18next.t('windows.advanced')}
					{!showWindowsAdvanced &&
						windowsDriversPath &&
						` (${i18next.t('windows.driversEnabled')})`}
				</Link>
				{showWindowsAdvanced && this.renderWindowsDrivers()}
			</Flex>
		);
	}

	private renderWindowsDrivers() {
		const { windowsDriversPath, isFlashing } = this.state;
		return (
			<Flex mt="12px" alignItems="center" justifyContent="space-between">
				<Flex flexDirection="column" mr="16px" style={{ minWidth: 0 }}>
					<Txt bold>{i18next.t('windows.drivers')}</Txt>
					<Txt
						style={{
							overflow: 'hidden',
							textOverflow: 'ellipsis',
							whiteSpace: 'nowrap',
						}}
						tooltip={windowsDriversPath || undefined}
					>
						{windowsDriversPath || i18next.t('windows.driversHint')}
					</Txt>
				</Flex>
				<Flex style={{ flexShrink: 0 }}>
					{windowsDriversPath && (
						<Button
							plain
							mr="12px"
							disabled={isFlashing}
							onClick={() => this.setWindowsDriversPath('')}
						>
							{i18next.t('windows.removeDrivers')}
						</Button>
					)}
					<Button
						disabled={isFlashing}
						onClick={() => this.selectWindowsDrivers()}
					>
						{i18next.t('windows.chooseDrivers')}
					</Button>
				</Flex>
			</Flex>
		);
	}

	public componentDidUpdate(
		_prevProps: object,
		prevState: Readonly<MainPageState & MainPageStateFromStore>,
	) {
		if (this.state.analyticsAlertIsVisible) {
			if (prevState.hideSettings !== this.state.hideSettings) {
				this.setState({ analyticsAlertIsVisible: false });
			}
		}
	}

	private renderMain() {
		const state = flashState.getFlashState();
		const shouldDriveStepBeDisabled = !this.state.hasImage;
		const shouldFlashStepBeDisabled =
			!this.state.hasImage || !this.state.hasDrive;
		const notFlashingOrSplitView =
			!this.state.isFlashing || !this.state.isWebviewShowing;
		const isWindowsMode = this.state.flashMode === 'windows';
		return (
			<Flex
				m={`0 ${this.state.isWebviewShowing ? 35 : 55}px 18px ${this.state.isWebviewShowing ? 35 : 55}px`}
				flexDirection="column"
			>
				{notFlashingOrSplitView && this.renderTabs()}
				<Flex
					justifyContent="space-between"
					mt={notFlashingOrSplitView ? undefined : '110px'}
					mb={
						this.state.analyticsAlertIsVisible || isWindowsMode ? '0px' : '92px'
					}
				>
					{notFlashingOrSplitView && (
						<>
							<SourceSelector
								flashing={this.state.isFlashing}
								hideAnalyticsAlert={this.hideAnalyticsAlert}
								windowsMode={isWindowsMode}
							/>
							<Flex>
								<StepBorder disabled={shouldDriveStepBeDisabled} left />
							</Flex>
							<TargetSelector
								disabled={shouldDriveStepBeDisabled}
								hasDrive={this.state.hasDrive}
								flashing={this.state.isFlashing}
								hideAnalyticsAlert={this.hideAnalyticsAlert}
							/>
							<Flex>
								<StepBorder disabled={shouldFlashStepBeDisabled} right />
							</Flex>
						</>
					)}

					{this.state.isFlashing && this.state.isWebviewShowing && (
						<Flex
							style={{
								position: 'absolute',
								top: 0,
								left: 0,
								width: '36.2vw',
								height: '100vh',
								zIndex: 1,
								boxShadow: '0 2px 15px 0 rgba(0, 0, 0, 0.2)',
							}}
						>
							<ReducedFlashingInfos
								imageLogo={this.state.imageLogo}
								imageName={this.state.imageName}
								imageSize={
									typeof this.state.imageSize === 'number'
										? prettyBytes(this.state.imageSize)
										: ''
								}
								driveTitle={this.state.driveTitle}
								driveLabel={this.state.driveLabel}
								style={{
									position: 'absolute',
									color: '#fff',
									left: 35,
									top: 72,
								}}
							/>
						</Flex>
					)}
					{this.state.isFlashing && this.state.featuredProjectURL && (
						<SafeWebview
							src={this.state.featuredProjectURL}
							onWebviewShow={(isWebviewShowing: boolean) => {
								this.setState({ isWebviewShowing });
							}}
							style={{
								position: 'absolute',
								right: 0,
								bottom: 0,
								width: '63.8vw',
								height: '100vh',
							}}
						/>
					)}

					<FlashStep
						width={this.state.isWebviewShowing ? '220px' : '200px'}
						goToSuccess={() => this.setState({ current: 'success' })}
						shouldFlashStepBeDisabled={shouldFlashStepBeDisabled}
						isFlashing={this.state.isFlashing}
						step={state.type}
						percentage={state.percentage}
						position={state.position}
						failed={state.failed}
						speed={state.speed}
						eta={state.eta}
						style={{ zIndex: 1 }}
					/>
				</Flex>
				{isWindowsMode && notFlashingOrSplitView && this.renderWindowsOptions()}
				{this.state.analyticsAlertIsVisible && (
					<Alert mt="18px" style={{ boxShadow: 'none', fontSize: '12px' }}>
						<Flex alignItems="center" justifyContent="space-between">
							<Flex flexDirection="column">
								<div>
									Etcher collects a limited amount of anonymous data to help us
									improve user experience. You can opt out in the{' '}
									<Link onClick={() => this.setState({ hideSettings: false })}>
										settings
									</Link>
									.
								</div>
								<div>
									For more information about how we use this data, see our{' '}
									<Link
										onClick={(e) => {
											e.stopPropagation();
											openExternal('https://www.balena.io/privacy-policy');
										}}
									>
										privacy policy
									</Link>
									.
								</div>
							</Flex>
							{/* TODO: can we use onDismiss instead? */}
							<IconButton onClick={this.hideAnalyticsAlert}>
								<CloseSvg height="0.75rem" fill={theme.colors.text.main} />
							</IconButton>
						</Flex>
					</Alert>
				)}
			</Flex>
		);
	}

	private renderSuccess() {
		return (
			<FinishPage
				goToMain={() => {
					flashState.resetState();
					this.setState({ current: 'main' });
				}}
			/>
		);
	}

	public render() {
		return (
			<ThemedProvider style={{ height: '100%', width: '100%' }}>
				<Flex
					justifyContent="space-between"
					alignItems="center"
					paddingTop="14px"
					style={{
						// Allow window to be dragged from header
						// @ts-ignore
						WebkitAppRegion: 'drag',
						position: 'relative',
						zIndex: 2,
					}}
				>
					<Flex width="100%" />
					<Flex width="100%" alignItems="center" justifyContent="center">
						<EtcherSvg
							width="123px"
							height="22px"
							style={{
								cursor: 'pointer',
							}}
							onClick={() =>
								openExternal('https://www.balena.io/etcher?ref=etcher_footer')
							}
							tabIndex={100}
						/>
					</Flex>

					<Flex width="100%" alignItems="center" justifyContent="flex-end">
						<Icon
							icon={<CogSvg height="1em" fill="currentColor" />}
							plain
							tabIndex={5}
							onClick={() => this.setState({ hideSettings: false })}
							style={{
								// Make touch events click instead of dragging
								WebkitAppRegion: 'no-drag',
							}}
						/>
						{!settings.getSync('disableExternalLinks') && (
							<Icon
								icon={<QuestionCircleSvg height="1em" fill="currentColor" />}
								onClick={() =>
									openExternal(
										selectionState.getImage()?.supportUrl ||
											'https://github.com/balena-io/etcher/blob/master/docs/SUPPORT.md',
									)
								}
								tabIndex={6}
								style={{
									// Make touch events click instead of dragging
									WebkitAppRegion: 'no-drag',
								}}
							/>
						)}
					</Flex>
				</Flex>
				{this.state.hideSettings ? null : (
					<SettingsModal
						toggleModal={(value: boolean) => {
							this.setState({ hideSettings: !value });
						}}
					/>
				)}
				{this.state.current === 'main'
					? this.renderMain()
					: this.renderSuccess()}
			</ThemedProvider>
		);
	}
}

export default MainPage;
